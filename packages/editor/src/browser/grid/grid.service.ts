import { IEditorGroup, IEditorGroupState, Direction } from '../../common';
import { observable } from 'mobx';
import { IDisposable, IEventBus, MaybeNull } from '@ali/ide-core-browser';
import { makeRandomHexString } from '@ali/ide-core-common/lib/functional';
import { Autowired } from '@ali/common-di';
import { GridResizeEvent } from '../types';

export const editorGridUid = new Set();

export class EditorGrid implements IDisposable {

  public editorGroup: IGridEditorGroup | null = null;

  @observable.shallow public children: EditorGrid[] = [];

  public splitDirection: SplitDirection | undefined;

  public readonly uid: string;

  constructor(public parent?: EditorGrid) {
    let uid = makeRandomHexString(5);
    while (editorGridUid.has(uid)) {
      uid = makeRandomHexString(5);
    }
    this.uid = uid;
    editorGridUid.add(uid);
  }

  setEditorGroup(editorGroup: IGridEditorGroup) {
    this.editorGroup = editorGroup;
    editorGroup.grid = this;
  }
  // 当前 grid 作为 parent ，原有 grid 与新增 grid 作为子元素
  private generateSplitParent(direction: SplitDirection, editorGroup: IGridEditorGroup, before?: boolean) {
    this.splitDirection = direction;
    const originalChild = new EditorGrid(this);
    originalChild.setEditorGroup(this.editorGroup!);
    this.editorGroup = null;
    const newGrid = new EditorGrid(this);
    newGrid.setEditorGroup(editorGroup);
    if (before) {
      this.children = [newGrid, originalChild];
    } else {
      this.children = [originalChild, newGrid];
    }
  }
  // 新增 grid 与当前 grid 作为同一父 grid 的子元素
  private generateSplitSibling(editorGroup: IGridEditorGroup, before?: boolean) {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      const newGrid = new EditorGrid(this.parent);
      newGrid.setEditorGroup(editorGroup);

      if (before) {
        this.parent.children.splice(index, 0, newGrid);
      } else {
        this.parent.children.splice(index + 1, 0, newGrid);
      }
    }
  }
  public split(direction: SplitDirection, editorGroup: IGridEditorGroup, before?: boolean) {
    // 由于split永远只会从未分割的含有editorGroup的grid发出
    // 父元素不含有实际渲染 ui
    if (!this.splitDirection) {
      // 顶层 grid 且未有指定方向，生成初始父级单元
      if (!this.parent) {
        this.generateSplitParent(direction, editorGroup, before);
      // 非顶层 grid
      } else {
        // 与父元素方向一致，则为同级子元素
        if (this.parent.splitDirection === direction) {
          this.generateSplitSibling(editorGroup, before);
        // 与父元素方向不一致，则生成为父级单元
        } else if (this.parent.splitDirection !== direction) {
          this.generateSplitParent(direction, editorGroup, before);
        }
      }
    }
  }

  public dispose() {
    if (this.editorGroup) {
      this.editorGroup = null;
      if (!this.parent) {
        return; // geng
      }
      const index = this.parent.children.indexOf(this);
      this.parent.children.splice(index, 1);
      if (this.parent.children.length === 1) {
        this.parent.replaceBy(this.parent.children[0]);
      }
    } else {
      // 应该不会落入这里
    }
  }

  public replaceBy(target: EditorGrid) {
    if (target.editorGroup) {
      this.setEditorGroup(target.editorGroup);
    }
    this.splitDirection = target.splitDirection;
    this.children.splice(0, this.children.length, ...target.children.splice(0, target.children.length));
    this.children.forEach((grid) => {
      grid.parent = this;
    });
  }

  public emitResizeWithEventBus(eventBus: IEventBus) {
    eventBus.fire(new GridResizeEvent({gridId: this.uid}));
    this.children.forEach((c) => {
      c.emitResizeWithEventBus(eventBus);
    });
  }

  serialize(): IEditorGridState | null {
    if (this.editorGroup) {
      if (this.parent && this.editorGroup.resources.length === 0) {
        return null;
      }
      return {
        editorGroup: this.editorGroup.getState(),
      };
    } else {
      if (this.parent && this.children.length === 0) {
        return null;
      }
      const children = this.children.map((c) => c.serialize()).filter((c) => !!c) as  IEditorGridState[];
      if (children.length === 1) {
        // 只有一个孩子，直接覆盖
        return children[0];
      }
      return {
        splitDirection: this.splitDirection,
        children,
      };
    }
  }

  deserialize(state: IEditorGridState, editorGroupFactory: () => IGridEditorGroup) {
    if (state.editorGroup) {
      this.setEditorGroup(editorGroupFactory());
      this.editorGroup!.restoreState(state.editorGroup);
    } else {
      this.splitDirection = state.splitDirection;
      this.children = (state.children || []).map((c) => {
        const grid = new EditorGrid(this);
        grid.deserialize(c, editorGroupFactory);
        return grid;
      });
    }
  }

  findGird(direction: Direction, currentIndex = 0): MaybeNull<EditorGrid> {
    if (this.splitDirection && splitDirectionMatches(this.splitDirection, direction)) {
      const targetIndex = currentIndex + ((direction === Direction.LEFT || direction === Direction.UP) ? -1 : 1);
      if (this.children[targetIndex]) {
        return this.children[targetIndex].getFirstLeaf();
      }
    }

    if (!this.parent) {
      return null;
    } else {
      return this.parent.findGird(direction, this.parent.children.indexOf(this));
    }
  }

  getFirstLeaf(): MaybeNull<EditorGrid> {
    if (this.editorGroup) {
      return this;
    } else {
      if (this.children.length > 0) {
        return this.children[0].getFirstLeaf();
      } else {
        return null;
      }
    }
  }

}

export interface IEditorGridState {
  editorGroup?: IEditorGroupState;
  splitDirection?: SplitDirection;
  children?: IEditorGridState[];
}

export interface IGridChild {
  grid: EditorGrid;
  percentage: number; // 0-100
}

export enum SplitDirection {
  // 水平拆分
  Horizontal = 1,

  // 垂直拆分
  Vertical = 2,
}

export interface IGridEditorGroup extends IEditorGroup {

  grid: EditorGrid;

}

export function splitDirectionMatches(split: SplitDirection, direction: Direction): boolean {
  if (direction === Direction.UP || direction === Direction.DOWN) {
    return split === SplitDirection.Vertical;
  }

  if (direction === Direction.LEFT || direction === Direction.RIGHT) {
    return split === SplitDirection.Horizontal;
  }

  return false;
}
