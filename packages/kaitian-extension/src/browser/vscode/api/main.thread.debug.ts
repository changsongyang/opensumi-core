import { Injectable, Optinal, Autowired, Injector, INJECTOR_TOKEN } from '@ali/common-di';
import { IMainThreadDebug, ExtHostAPIIdentifier, IExtHostDebug, ExtensionWSChannel, IMainThreadConnectionService, IStartDebuggingOptions } from '../../../common/vscode';
import { DisposableCollection, Uri, ILoggerManagerClient, ILogServiceClient, SupportLogNamespace, URI } from '@ali/ide-core-browser';
import { DebuggerDescription, IDebugService, DebugConfiguration, IDebugServer, IDebuggerContribution, IDebugServiceContributionPoint } from '@ali/ide-debug';
import { DebugSessionManager, BreakpointManager, DebugConfigurationManager, DebugPreferences, DebugSessionContributionRegistry, DebugModelManager, DebugBreakpoint } from '@ali/ide-debug/lib/browser';
import { IRPCProtocol } from '@ali/ide-connection';
import { LabelService } from '@ali/ide-core-browser/lib/services';
import { IFileServiceClient } from '@ali/ide-file-service';
import { WorkbenchEditorService } from '@ali/ide-editor';
import { IMessageService } from '@ali/ide-overlay';
import { ExtensionDebugSessionFactory, ExtensionDebugSessionContributionRegistry } from './debug';
import { ExtensionDebugService } from './debug/extension-debug-service';
import { ExtensionDebugAdapterContribution } from './debug/extension-debug-adapter-contribution';
import { IActivationEventService } from '../../types';
import { Breakpoint, WorkspaceFolder } from '../../../common/vscode/models';
import { DebugProtocol } from 'vscode-debugprotocol';
import { IDebugSessionManager, IDebugSessionOptions } from '@ali/ide-debug/lib/common/debug-session';
import { ITerminalApiService } from '@ali/ide-terminal-next';
import { OutputService } from '@ali/ide-output/lib/browser/output.service';
import { DebugConsoleModelService } from '@ali/ide-debug/lib/browser/view/console/debug-console-tree.model.service';

@Injectable({ multiple: true })
export class MainThreadDebug implements IMainThreadDebug {

  private readonly toDispose = new Map<string, DisposableCollection>();
  private readonly listenerDispose = new DisposableCollection();

  private proxy: IExtHostDebug;

  @Autowired(IDebugSessionManager)
  protected readonly sessionManager: DebugSessionManager;

  @Autowired(LabelService)
  protected readonly labelService: LabelService;

  @Autowired(BreakpointManager)
  protected readonly breakpointManager: BreakpointManager;

  @Autowired(DebugModelManager)
  protected readonly modelManager: DebugModelManager;

  @Autowired(DebugConfigurationManager)
  protected readonly debugConfigurationManager: DebugConfigurationManager;

  @Autowired(DebugPreferences)
  protected readonly debugPreferences: DebugPreferences;

  @Autowired(WorkbenchEditorService)
  protected readonly editorService: WorkbenchEditorService;

  @Autowired(IMessageService)
  protected readonly messageService: IMessageService;

  @Autowired(IFileServiceClient)
  protected readonly fileService: IFileServiceClient;

  @Autowired(IDebugServer)
  protected readonly adapterContributionRegister: ExtensionDebugService;

  @Autowired(IActivationEventService)
  protected readonly activationEventService: IActivationEventService;

  @Autowired(DebugSessionContributionRegistry)
  protected readonly sessionContributionRegistry: ExtensionDebugSessionContributionRegistry;

  @Autowired(ILoggerManagerClient)
  protected readonly loggerManager: ILoggerManagerClient;
  protected readonly logger: ILogServiceClient;

  @Autowired(ITerminalApiService)
  protected readonly terminalService: ITerminalApiService;

  @Autowired(DebugConsoleModelService)
  protected readonly debugConsoleModelService: DebugConsoleModelService;

  @Autowired(OutputService)
  protected readonly outputService: OutputService;

  @Autowired(IDebugService)
  protected readonly debugService: IDebugService;

  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  constructor(
    @Optinal(IRPCProtocol) private rpcProtocol: IRPCProtocol,
    @Optinal(IMainThreadConnectionService) private mainThreadConnection: IMainThreadConnectionService,
  ) {
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.ExtensionHost);
    this.proxy = this.rpcProtocol.getProxy(ExtHostAPIIdentifier.ExtHostDebug);
    this.listen();
    this.registerDebugContributions();

  }

  public dispose() {
    this.toDispose.forEach((disposable) => {
      disposable.dispose();
    });

    this.toDispose.clear();
    this.listenerDispose.dispose();
  }

  private listen() {
    this.listenerDispose.pushAll([
      this.breakpointManager.onDidChangeBreakpoints(({ added, removed, changed }) => {
        const all = this.breakpointManager.getBreakpoints();
        this.proxy.$breakpointsDidChange(
          this.toCustomApiBreakpoints(all),
          this.toCustomApiBreakpoints(added),
          this.toCustomApiBreakpoints(removed),
          this.toCustomApiBreakpoints(changed),
        );
      }),
      this.sessionManager.onDidStartDebugSession((debugSession) => {
        this.proxy.$sessionDidStart(debugSession.id);
      }),
      this.sessionManager.onDidDestroyDebugSession((debugSession) => {
        this.proxy.$sessionDidDestroy(debugSession.id);
      }),
      this.sessionManager.onDidChangeActiveDebugSession((event) => {
        this.proxy.$sessionDidChange(event.current && event.current.id);
      }),
      this.sessionManager.onDidReceiveDebugSessionCustomEvent((event) => {
        this.proxy.$onSessionCustomEvent(event.session.id, event.event, event.body);
      }),
      this.debugService.onDidDebugContributionPointChange(({ path, contributions, removed}: IDebugServiceContributionPoint) => {
        // 新增调试插件时注册对应调试能力
        if (removed) {
          this.proxy.$unregisterDebuggerContributions(contributions as IDebuggerContribution[]);
          contributions.forEach((contribution: any) => {
            this.$unregisterDebuggerContribution({
              type: contribution.type,
              label: contribution.label || contribution.type,
            });
            this.logger.log(`Debugger contribution has been unregistered: ${contribution.type}`);
          });
        } else {
          this.proxy.$registerDebuggerContributions(path, contributions as IDebuggerContribution[]);
          contributions.forEach((contribution: any) => {
            this.$registerDebuggerContribution({
              type: contribution.type,
              label: contribution.label || contribution.type,
            });
            this.logger.log(`Debugger contribution has been registered: ${contribution.type}`);
          });
        }
      }),
    ]);
  }

  private registerDebugContributions() {
    const debugContributionPoints = this.debugService.debugContributionPoints;
    // 需确保在贡献点注册完后执行
    // 将ContributionPoints中的debuggers数据传递给插件
    // 后续时序若发生调整，这块逻辑也需要调整
    for (const [folder, contributions] of debugContributionPoints) {
      this.proxy.$registerDebuggerContributions(folder, contributions as IDebuggerContribution[]);
      contributions.forEach((contribution: any) => {
        this.$registerDebuggerContribution({
          type: contribution.type,
          label: contribution.label || contribution.type,
        });
        this.logger.log(`Debugger contribution has been registered: ${contribution.type}`);
      });
    }
  }

  async $appendToDebugConsole(value: string): Promise<void> {
    if (this.debugConsoleModelService.debugConsoleSession) {
      this.debugConsoleModelService.debugConsoleSession.append(value);
    }
  }

  async $appendLineToDebugConsole(value: string): Promise<void> {
    if (this.debugConsoleModelService.debugConsoleSession) {
      this.debugConsoleModelService.debugConsoleSession.appendLine(value);
    }
  }

  async $unregisterDebuggerContribution(description: DebuggerDescription) {
    const disposable = this.toDispose.get(description.type);
    disposable?.dispose();
  }

  async $registerDebuggerContribution(description: DebuggerDescription): Promise<void> {
    const disposable = new DisposableCollection();
    const terminalOptionsExt = await this.proxy.$getTerminalCreationOptions(description.type);
    this.toDispose.set(description.type, disposable);
    const debugSessionFactory = new ExtensionDebugSessionFactory(
      this.editorService,
      this.breakpointManager,
      this.modelManager,
      this.terminalService,
      this.labelService,
      this.messageService,
      this.debugPreferences,
      async (sessionId: string) => {
        const connection = await this.mainThreadConnection.ensureConnection(sessionId);
        return new ExtensionWSChannel(connection);
      },
      this.fileService,
      terminalOptionsExt,
      this.debugPreferences,
      this.outputService,
      this.injector,
    );
    disposable.pushAll([
      this.adapterContributionRegister.registerDebugAdapterContribution(
        new ExtensionDebugAdapterContribution(description, this.proxy, this.activationEventService),
      ),
      this.sessionContributionRegistry.registerDebugSessionContribution({
        debugType: description.type,
        debugSessionFactory: () => debugSessionFactory,
      }),
    ]);
  }

  async $addBreakpoints(breakpoints: Breakpoint[]): Promise<void> {
    const newBreakpoints = new Map<string, Breakpoint>();
    breakpoints.forEach((b) => newBreakpoints.set(b.id, b));
    this.breakpointManager.findMarkers({
      dataFilter: (data) => {
        // 至存储未被标记的断点信息
        if (newBreakpoints.has(data.id)) {
          newBreakpoints.delete(data.id);
        }
        return false;
      },
    });
    for (const breakpoint of newBreakpoints.values()) {
      if (breakpoint.location) {
        const location = breakpoint.location;
        this.breakpointManager.addBreakpoint(DebugBreakpoint.create(
          Uri.revive(location.uri) as any,
          {
            line: breakpoint.location.range.startLineNumber + 1,
            column: 1,
            condition: breakpoint.condition,
            hitCondition: breakpoint.hitCondition,
            logMessage: breakpoint.logMessage,
          },
          true,
        ));
      }
    }
  }

  async $removeBreakpoints(breakpoints: Breakpoint[]): Promise<void> {
    const ids = new Set<string>();
    breakpoints.forEach((b) => ids.add(b.id));
    for (const origin of this.breakpointManager.findMarkers({ dataFilter: (data) => ids.has(data.id) })) {
      const model = this.modelManager.resolve(new URI(origin.data.uri));
      if (model && model[0].breakpoint) {
        model[0].breakpoint.remove();
      }
    }
  }

  async $customRequest(sessionId: string, command: string, args?: any): Promise<DebugProtocol.Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      return session.sendCustomRequest(command, args);
    }

    throw new Error(`Debug session '${sessionId}' not found`);
  }

  async $startDebugging(folder: WorkspaceFolder | undefined, nameOrConfiguration: string | DebugConfiguration, options: IStartDebuggingOptions): Promise<boolean> {
    let configuration: DebugConfiguration | undefined;
    let index = 0;
    if (typeof nameOrConfiguration === 'string') {
      for (const options of this.debugConfigurationManager.all) {
        if (options.configuration.name === nameOrConfiguration) {
          configuration = options.configuration;
          break;
        }
        index ++;
      }
    } else {
      configuration = nameOrConfiguration;
    }

    if (!configuration) {
      throw new Error(`No configuration ${nameOrConfiguration}`);
    }

    const debugOptions: IDebugSessionOptions = {
      noDebug: false,
      parentSession: this.sessionManager.getSession(options.parentSessionID),
      repl: options.repl,
    };

    const session = await this.sessionManager.start({
      configuration,
      workspaceFolderUri: folder && Uri.revive(folder.uri).toString(),
      index,
      ...debugOptions,
    });

    return !!session;
  }

  private toCustomApiBreakpoints(sourceBreakpoints: DebugBreakpoint[]): Breakpoint[] {
    return sourceBreakpoints.map((b) => ({
      id: b.id,
      enabled: b.enabled,
      condition: b.raw.condition,
      hitCondition: b.raw.hitCondition,
      logMessage: b.raw.logMessage,
      location: {
        uri: Uri.parse(b.uri),
        range: {
          startLineNumber: b.raw.line - 1,
          startColumn: (b.raw.column || 1) - 1,
          endLineNumber: b.raw.line - 1,
          endColumn: (b.raw.column || 1) - 1,
        },
      },
    }));
  }
}
