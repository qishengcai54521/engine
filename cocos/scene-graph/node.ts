/*
 Copyright (c) 2017-2018 Xiamen Yaji Software Co., Ltd.

 http://www.cocos.com

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
  worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
  not use Cocos Creator software for developing other software or tools that's
  used for developing games. You are not granted to publish, distribute,
  sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

/**
 * @category scene-graph
 */

import { UITransformComponent } from '../3d';
import { ccclass, property } from '../core/data/class-decorator';
import { constget } from '../core/data/utils/constget';
import Event from '../core/event/event';
import { eventManager } from '../core/platform/event-manager';
import { SystemEventType } from '../core/platform/event-manager/event-enum';
import { Mat4, Quat, Vec3 } from '../core/value-types';
import Size from '../core/value-types/size';
import Vec2 from '../core/value-types/vec2';
import { mat4, quat, vec3 } from '../core/vmath';
import { BaseNode } from './base-node';
import { Layers } from './layers';
import { NodeEventProcessor } from './node-event-processor';

const v3_a = new Vec3();
const q_a = new Quat();
const array_a = new Array(10);

enum NodeSpace {
    LOCAL,
    WORLD,
}
const TRANFORM_ON = 1 << 0;

/**
 * @zh
 * 场景树中的基本节点，基本特性有：
 * * 具有层级关系
 * * 持有各类组件
 * * 维护空间变换（坐标、旋转、缩放）信息
 */
@ccclass('cc.Node')
export class Node extends BaseNode {
    /**
     * @zh
     * 节点可能发出的事件类型
     */
    public static EventType = SystemEventType;
    /**
     * @zh
     * 空间变换操作的坐标系
     */
    public static NodeSpace = NodeSpace;

    /**
     * @zh
     * 指定对象是否是普通的场景节点？
     * @param obj 待测试的节点
     */
    public static isNode (obj: object | null): obj is Node {
        return obj instanceof Node && (obj.constructor === Node || !(obj instanceof cc.Scene));
    }

    // world transform, don't access this directly
    protected _pos = new Vec3();
    protected _rot = new Quat();
    protected _scale = new Vec3(1, 1, 1);
    protected _mat = new Mat4();

    // local transform
    @property
    protected _lpos = new Vec3();
    @property
    protected _lrot = new Quat();
    @property
    protected _lscale = new Vec3(1, 1, 1);
    @property
    protected _layer = Layers.Default; // the layer this node belongs to

    // local rotation in euler angles, maintained here so that rotation angles could be greater than 360 degree.
    @property
    protected _euler = new Vec3();

    protected _dirty = false; // does the world transform need to update?
    protected _hasChanged = false; // has the transform changed in this frame?

    protected _matDirty = false;
    protected _eulerDirty = false;

    protected _eventProcessor: NodeEventProcessor = new cc.NodeEventProcessor(this);
    protected _eventMask = 0;
    private _uiTransfromComp: UITransformComponent | null = null;

    /**
     * @zh
     * 以欧拉角表示的本地旋转值
     */
    @property({ type: Vec3 })
    set eulerAngles (val: Readonly<Vec3>) {
        this.setRotationFromEuler(val.x, val.y, val.z);
    }
    get eulerAngles () {
        if (this._eulerDirty) {
            quat.toEuler(this._euler, this._lrot);
            this._eulerDirty = false;
        }
        return this._euler;
    }

    /**
     * @zh
     * 节点所属层，主要影响射线检测、物理碰撞等，参考 [[Layers]]
     */
    @property
    set layer (l) {
        this._layer = l;
    }
    get layer () {
        return this._layer;
    }

    /**
     * @zh
     * 这个节点的空间变换信息在当前帧内是否有变过？
     */
    get hasChanged () {
        return this._hasChanged;
    }

    // ===============================
    // hierarchy
    // ===============================

    /**
     * @zh
     * 设置父节点
     * @param value 父节点
     * @param keepWorldTransform 是否保留当前世界变换
     */
    public setParent (value: this | null, keepWorldTransform: boolean = false) {
        if (keepWorldTransform) { this.updateWorldTransform(); }
        super.setParent(value, keepWorldTransform);
    }

    public _onSetParent (oldParent: this | null, keepWorldTransform: boolean) {
        super._onSetParent(oldParent, keepWorldTransform);
        if (keepWorldTransform) {
            const parent = this._parent;
            const local = this._lpos;
            if (parent) {
                parent.updateWorldTransform();
                vec3.subtract(local, this._pos, parent._pos);
                vec3.transformQuat(local, local, quat.conjugate(q_a, parent._rot));
                vec3.divide(local, local, parent._scale);
                quat.multiply(this._lrot, quat.conjugate(q_a, parent._rot), this._rot);
                vec3.divide(this._lscale, this._scale, parent._scale);
            } else {
                vec3.copy(this._lpos, this._pos);
                quat.copy(this._lrot, this._rot);
                vec3.copy(this._lscale, this._scale);
            }
            this._eulerDirty = true;
        } else {
            vec3.copy(this._pos, this._lpos);
            quat.copy(this._rot, this._lrot);
            vec3.copy(this._scale, this._lscale);
        }

        this.invalidateChildren();
    }

    public _onBatchCreated () {
        vec3.copy(this._pos, this._lpos);
        quat.copy(this._rot, this._lrot);
        vec3.copy(this._scale, this._lscale);
        this._dirty = this._hasChanged = true;
        this._eventMask = 0;
        for (const child of this._children) {
            child._onBatchCreated();
        }
    }

    public _onBatchRestored () {
        this._onBatchCreated();
    }

    public _onBeforeSerialize () {
        // tslint:disable-next-line: no-unused-expression
        this.eulerAngles; // make sure we save the correct eulerAngles
    }

    // ===============================
    // transform helper, convenient but not the most efficient
    // ===============================

    /**
     * @zh
     * 移动节点
     * @param trans 位置增量
     * @param ns 操作空间
     */
    public translate (trans: Vec3, ns?: NodeSpace) {
        const space = ns || NodeSpace.LOCAL;
        vec3.copy(v3_a, this._lpos);
        if (space === NodeSpace.LOCAL) {
            vec3.transformQuat(v3_a, trans, this.worldRotation);
            this.setPosition(vec3.add(v3_a, this._lpos, v3_a));
        } else if (space === NodeSpace.WORLD) {
            this.setPosition(vec3.add(v3_a, this._lpos, trans));
        }
    }

    /**
     * @zh
     * 旋转节点
     * @param trans 旋转增量
     * @param ns 操作空间
     */
    public rotate (rot: Quat, ns?: NodeSpace) {
        const space = ns || NodeSpace.LOCAL;
        if (space === NodeSpace.LOCAL) {
            this.getRotation(q_a);
            this.setRotation(quat.multiply(q_a, q_a, rot));
        } else if (space === NodeSpace.WORLD) {
            this.getWorldRotation(q_a);
            this.setWorldRotation(quat.multiply(q_a, rot, q_a));
        }
    }

    /**
     * @zh
     * 当前节点面向的前方方向
     */
    get forward (): Vec3 {
        this.getWorldRotation(q_a);
        return vec3.transformQuat(new Vec3(), vec3.UNIT_Z, q_a);
    }
    set forward (dir: Vec3) {
        const len = vec3.magnitude(dir);
        vec3.scale(v3_a, dir, -1 / len); // we use -z for view-dir
        quat.fromViewUp(q_a, v3_a);
        this.setWorldRotation(q_a);
    }

    /**
     * @zh
     * 设置当前节点旋转为面向目标位置
     * @param pos 目标位置
     * @param up 坐标系的上方向
     */
    public lookAt (pos: Vec3, up?: Vec3) {
        this.getWorldPosition(v3_a);
        vec3.subtract(v3_a, v3_a, pos); // we use -z for view-dir
        vec3.normalize(v3_a, v3_a);
        quat.fromViewUp(q_a, v3_a, up);
        this.setWorldRotation(q_a);
    }

    // ===============================
    // transform maintainer
    // ===============================

    /**
     * @en
     * Reset the `hasChanged` flag recursively
     * @zh
     * 递归重置节点的 hasChanged 标记为 false
     */
    public resetHasChanged () {
        this._hasChanged = false;
        const len = this._children.length;
        for (let i = 0; i < len; ++i) {
            this._children[i].resetHasChanged();
        }
    }

    /**
     * @en
     * invalidate the world transform information
     * for this node and all its children recursively
     * @zh
     * 递归标记节点世界变换为 dirty
     */
    public invalidateChildren () {
        if (this._dirty && this._hasChanged) { return; }
        this._dirty = this._hasChanged = true;
        for (const child of this._children) {
            child.invalidateChildren();
        }
    }

    /**
     * @en
     * update the world transform information if outdated
     * here we assume all nodes are children of a scene node,
     * which is always not dirty, has an identity transform and no parent.
     * @zh
     * 更新节点的世界变换信息
     */
    public updateWorldTransform () {
        if (!this._dirty) { return; }
        let cur: this | null = this;
        let i = 0;
        while (cur._dirty) {
            // top level node
            array_a[i++] = cur;
            cur = cur._parent;
            if (!cur || !cur._parent) {
                cur = null;
                break;
            }
        }
        let child: this;
        while (i) {
            child = array_a[--i];
            if (cur) {
                vec3.multiply(child._pos, child._lpos, cur._scale);
                vec3.transformQuat(child._pos, child._pos, cur._rot);
                vec3.add(child._pos, child._pos, cur._pos);
                quat.multiply(child._rot, cur._rot, child._lrot);
                vec3.multiply(child._scale, cur._scale, child._lscale);
            }
            child._matDirty = true; // further deferred eval
            child._dirty = false;
            cur = child;
        }
    }

    /**
     * @zh
     * 更新节点的完整世界变换信息
     */
    public updateWorldTransformFull () {
        this.updateWorldTransform();
        if (!this._matDirty) { return; }
        mat4.fromRTS(this._mat, this._rot, this._pos, this._scale);
        this._matDirty = false;
    }

    // ===============================
    // transform
    // ===============================

    /**
     * @zh
     * 设置本地坐标
     * @param position 目标本地坐标
     */
    public setPosition (position: Vec3): void;

    /**
     * @zh
     * 设置本地坐标
     * @param x 目标本地坐标的 X 分量
     * @param y 目标本地坐标的 Y 分量
     * @param z 目标本地坐标的 Z 分量
     * @param w 目标本地坐标的 W 分量
     */
    public setPosition (x: number, y: number, z: number): void;

    public setPosition (val: Vec3 | number, y?: number, z?: number) {
        v3_a.set(this._lpos);
        if (y === undefined || z === undefined) {
            vec3.copy(this._lpos, val as Vec3);
        } else if (arguments.length === 3) {
            vec3.set(this._lpos, val as number, y, z);
        }
        vec3.copy(this._pos, this._lpos);

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.POSITION_PART);
        }
    }

    /**
     * @zh
     * 获取本地坐标
     * @param out 输出到此目标 vector
     */
    public getPosition (out?: Vec3): Vec3 {
        if (out) {
            return vec3.set(out, this._lpos.x, this._lpos.y, this._lpos.z);
        } else {
            return vec3.copy(new Vec3(), this._lpos);
        }
    }

    /**
     * @zh
     * 本地坐标
     */
    @constget
    public get position (): Readonly<Vec3> {
        return this._lpos;
    }
    public set position (val: Readonly<Vec3>) {
        this.setPosition(val);
    }

    /**
     * @zh
     * 设置本地旋转
     * @param rotation 目标本地旋转
     */
    public setRotation (rotation: Quat): void;

    /**
     * @zh
     * 设置本地旋转
     * @param x 目标本地旋转的 X 分量
     * @param y 目标本地旋转的 Y 分量
     * @param z 目标本地旋转的 Z 分量
     * @param w 目标本地旋转的 W 分量
     */
    public setRotation (x: number, y: number, z: number, w: number): void;

    public setRotation (val: Quat | number, y?: number, z?: number, w?: number) {
        if (y === undefined || z === undefined || w === undefined) {
            quat.copy(this._lrot, val as Quat);
        } else if (arguments.length === 4) {
            quat.set(this._lrot, val as number, y, z, w);
        }
        quat.copy(this._rot, this._lrot);
        this._eulerDirty = true;

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.ROTATION_PART);
        }
    }

    /**
     * @zh
     * 通过欧拉角设置本地旋转
     * @param x - 目标欧拉角的 X 分量
     * @param y - 目标欧拉角的 Y 分量
     * @param z - 目标欧拉角的 Z 分量
     */
    public setRotationFromEuler (x: number, y: number, z: number) {
        vec3.set(this._euler, x, y, z);
        this._eulerDirty = false;
        quat.fromEuler(this._lrot, x, y, z);
        quat.copy(this._rot, this._lrot);

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.ROTATION_PART);
        }
    }

    /**
     * @zh
     * 获取本地旋转
     * @param out 输出到此目标 quaternion
     */
    public getRotation (out?: Quat): Quat {
        if (out) {
            return quat.set(out, this._lrot.x, this._lrot.y, this._lrot.z, this._lrot.w);
        } else {
            return quat.copy(new Quat(), this._lrot);
        }
    }

    /**
     * @zh
     * 本地旋转
     */
    @constget
    public get rotation (): Readonly<Quat> {
        return this._lrot;
    }
    public set rotation (val: Readonly<Quat>) {
        this.setRotation(val);
    }

    /**
     * @zh
     * 设置本地缩放
     * @param scale 目标本地缩放
     */
    public setScale (scale: Vec3): void;

    /**
     * @zh
     * 设置本地缩放
     * @param x 目标本地缩放的 X 分量
     * @param y 目标本地缩放的 Y 分量
     * @param z 目标本地缩放的 Z 分量
     */
    public setScale (x: number, y: number, z: number): void;

    public setScale (val: Vec3 | number, y?: number, z?: number) {
        if (y === undefined || z === undefined) {
            vec3.copy(this._lscale, val as Vec3);
        } else if (arguments.length === 3) {
            vec3.set(this._lscale, val as number, y, z);
        }
        vec3.copy(this._scale, this._lscale);

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.SCALE_PART);
        }
    }

    /**
     * @zh
     * 获取本地缩放
     * @param out 输出到此目标 vector
     */
    public getScale (out?: Vec3): Vec3 {
        if (out) {
            return vec3.set(out, this._lscale.x, this._lscale.y, this._lscale.z);
        } else {
            return vec3.copy(new Vec3(), this._lscale);
        }
    }

    /**
     * @zh
     * 本地缩放
     */
    @constget
    public get scale (): Readonly<Vec3> {
        return this._lscale;
    }
    public set scale (val: Readonly<Vec3>) {
        this.setScale(val);
    }

    /**
     * @zh
     * 设置世界坐标
     * @param position 目标世界坐标
     */
    public setWorldPosition (position: Vec3): void;

    /**
     * @zh
     * 设置世界坐标
     * @param x 目标世界坐标的 X 分量
     * @param y 目标世界坐标的 Y 分量
     * @param z 目标世界坐标的 Z 分量
     * @param w 目标世界坐标的 W 分量
     */
    public setWorldPosition (x: number, y: number, z: number): void;

    public setWorldPosition (val: Vec3 | number, y?: number, z?: number) {
        if (y === undefined || z === undefined) {
            vec3.copy(this._pos, val as Vec3);
        } else if (arguments.length === 3) {
            vec3.set(this._pos, val as number, y, z);
        }
        const parent = this._parent;
        const local = this._lpos;
        v3_a.set(this._lpos);
        if (parent) {
            parent.updateWorldTransform();
            vec3.subtract(local, this._pos, parent._pos);
            vec3.transformQuat(local, local, quat.conjugate(q_a, parent._rot));
            vec3.divide(local, local, parent._scale);
        } else {
            vec3.copy(local, this._pos);
        }

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.POSITION_PART);
        }
    }

    /**
     * @zh
     * 获取世界坐标
     * @param out 输出到此目标 vector
     */
    public getWorldPosition (out?: Vec3): Vec3 {
        this.updateWorldTransform();
        if (out) {
            return vec3.copy(out, this._pos);
        } else {
            return vec3.copy(new Vec3(), this._pos);
        }
    }

    /**
     * @zh
     * 世界坐标
     */
    @constget
    public get worldPosition (): Readonly<Vec3> {
        this.updateWorldTransform();
        return this._pos;
    }
    public set worldPosition (val: Readonly<Vec3>) {
        this.setWorldPosition(val);
    }

    /**
     * @zh
     * 设置世界旋转
     * @param rotation 目标世界旋转
     */
    public setWorldRotation (rotation: Quat): void;

    /**
     * @zh
     * 设置世界旋转
     * @param x 目标世界旋转的 X 分量
     * @param y 目标世界旋转的 Y 分量
     * @param z 目标世界旋转的 Z 分量
     * @param w 目标世界旋转的 W 分量
     */
    public setWorldRotation (x: number, y: number, z: number, w: number): void;

    public setWorldRotation (val: Quat | number, y?: number, z?: number, w?: number) {
        if (y === undefined || z === undefined || w === undefined) {
            quat.copy(this._rot, val as Quat);
        } else if (arguments.length === 4) {
            quat.set(this._rot, val as number, y, z, w);
        }
        if (this._parent) {
            this._parent.getWorldRotation(q_a);
            quat.multiply(this._lrot, quat.conjugate(q_a, q_a), this._rot);
        } else {
            quat.copy(this._lrot, this._rot);
        }
        this._eulerDirty = true;

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.ROTATION_PART);
        }
    }

    /**
     * @zh
     * 通过欧拉角设置世界旋转
     * @param x - 目标欧拉角的 X 分量
     * @param y - 目标欧拉角的 Y 分量
     * @param z - 目标欧拉角的 Z 分量
     */
    public setWorldRotationFromEuler (x: number, y: number, z: number) {
        quat.fromEuler(this._rot, x, y, z);
        if (this._parent) {
            this._parent.getWorldRotation(q_a);
            quat.multiply(this._lrot, this._rot, quat.conjugate(q_a, q_a));
        } else {
            quat.copy(this._lrot, this._rot);
        }
        this._eulerDirty = true;

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.ROTATION_PART);
        }
    }

    /**
     * @zh
     * 获取世界旋转
     * @param out 输出到此目标 quaternion
     */
    public getWorldRotation (out?: Quat): Quat {
        this.updateWorldTransform();
        if (out) {
            return quat.copy(out, this._rot);
        } else {
            return quat.copy(new Quat(), this._rot);
        }
    }

    /**
     * @zh
     * 世界旋转
     */
    @constget
    public get worldRotation (): Readonly<Quat> {
        this.updateWorldTransform();
        return this._rot;
    }
    public set worldRotation (val: Readonly<Quat>) {
        this.setWorldRotation(val);
    }

    /**
     * @zh
     * 设置世界缩放
     * @param scale 目标世界缩放
     */
    public setWorldScale (scale: Vec3): void;

    /**
     * @zh
     * 设置世界缩放
     * @param x 目标世界缩放的 X 分量
     * @param y 目标世界缩放的 Y 分量
     * @param z 目标世界缩放的 Z 分量
     */
    public setWorldScale (x: number, y: number, z: number): void;

    public setWorldScale (val: Vec3 | number, y?: number, z?: number) {
        if (y === undefined || z === undefined) {
            vec3.copy(this._scale, val as Vec3);
        } else if (arguments.length === 3) {
            vec3.set(this._scale, val as number, y, z);
        }
        if (this._parent) {
            this._parent.getWorldScale(v3_a);
            vec3.divide(this._lscale, this._scale, v3_a);
        } else {
            vec3.copy(this._lscale, this._scale);
        }

        this.invalidateChildren();
        if (this._eventMask & TRANFORM_ON) {
            this.emit(SystemEventType.TRANSFORM_CHANGED, SystemEventType.SCALE_PART);
        }
    }

    /**
     * @zh
     * 获取世界缩放
     * @param out 输出到此目标 vector
     */
    public getWorldScale (out?: Vec3): Vec3 {
        this.updateWorldTransform();
        if (out) {
            return vec3.copy(out, this._scale);
        } else {
            return vec3.copy(new Vec3(), this._scale);
        }
    }

    /**
     * @zh
     * 世界缩放
     */
    @constget
    public get worldScale (): Readonly<Vec3> {
        this.updateWorldTransform();
        return this._scale;
    }
    public set worldScale (val: Readonly<Vec3>) {
        this.setWorldScale(val);
    }

    /**
     * @zh
     * 获取世界变换矩阵
     * @param out 输出到此目标矩阵
     */
    public getWorldMatrix (out?: Mat4) {
        this.updateWorldTransformFull();
        if (!out) { out = new Mat4(); }
        return mat4.copy(out, this._mat);
    }

    /**
     * @zh
     * 世界变换矩阵
     */
    @constget
    public get worldMatrix (): Readonly<Mat4> {
        this.updateWorldTransformFull();
        return this._mat;
    }

    /**
     * @zh
     * 获取只包含旋转和缩放的世界变换矩阵
     * @param out 输出到此目标矩阵
     */
    public getWorldRS (out?: Mat4): Mat4 {
        this.updateWorldTransformFull();
        if (!out) { out = new Mat4(); }
        mat4.copy(out, this._mat);
        out.m12 = 0; out.m13 = 0; out.m14 = 0;
        return out;
    }

    /**
     * @zh
     * 获取只包含坐标和旋转的世界变换矩阵
     * @param out 输出到此目标矩阵
     */
    public getWorldRT (out?: Mat4): Mat4 {
        this.updateWorldTransform();
        if (!out) { out = new Mat4(); }
        return mat4.fromRT(out, this._rot, this._pos);
    }

    // ===============================
    // creator-backward-compatible interfaces
    // ===============================

    // NOTE: don't set it manually
    get uiTransfromComp () {
        if (!this._uiTransfromComp) {
            this._uiTransfromComp = this.getComponent('cc.UITransformComponent') as UITransformComponent;
        }

        return this._uiTransfromComp;
    }
    set uiTransfromComp (value: UITransformComponent | null) {
        this._uiTransfromComp = value;
    }

    get width () {
        return this.uiTransfromComp!.width;
    }
    set width (value: number) {
        this.uiTransfromComp!.width = value;
    }

    get height () {
        return this.uiTransfromComp!.height;
    }
    set height (value: number) {
        this.uiTransfromComp!.height = value;
    }

    get anchorX () {
        return this.uiTransfromComp!.anchorX;
    }
    set anchorX (value) {
        this.uiTransfromComp!.anchorX = value;
    }

    get anchorY () {
        return this.uiTransfromComp!.anchorY;
    }
    set anchorY (value: number) {
        this.uiTransfromComp!.anchorY = value;
    }

    get eventProcessor () {
        return this._eventProcessor;
    }

    public getAnchorPoint (out?: Vec2) {
        if (!out) {
            out = new Vec2();
        }
        out.set(this.uiTransfromComp!.anchorPoint);
        return out;
    }

    public setAnchorPoint (point: Vec2 | number, y?: number) {
        this.uiTransfromComp!.setAnchorPoint(point, y);
    }

    public getContentSize (out?: Size) {
        if (!out){
            out = new Size();
        }

        out.set(this.uiTransfromComp!.contentSize);
        return out;
    }

    public setContentSize (size: Size | number, height?: number) {
        this.uiTransfromComp!.setContentSize(size, height);
    }

    // Event: maybe remove

    public on (type: string | SystemEventType, callback: Function, target?: Object, useCapture?: any) {
        switch (type) {
            case SystemEventType.TRANSFORM_CHANGED:
            this._eventMask |= TRANFORM_ON;
            break;
        }
        this._eventProcessor.on(type, callback, target, useCapture);
    }

    public off (type: string, callback?: Function, target?: Object, useCapture?: any) {
        this._eventProcessor.off(type, callback, target, useCapture);

        const hasListeners = this._eventProcessor.hasEventListener(type);
        // All listener removed
        if (!hasListeners) {
            switch (type) {
                case SystemEventType.TRANSFORM_CHANGED:
                this._eventMask &= ~TRANFORM_ON;
                break;
            }
        }
    }

    public once (type: string, callback: Function, target?: Object, useCapture?: any) {
        this._eventProcessor.once(type, callback, target, useCapture);
    }

    public emit (type: string, ...args: any[]) {
        this._eventProcessor.emit(type, ...args);
    }

    public dispatchEvent (event: Event) {
       this._eventProcessor.dispatchEvent(event);
    }

    public hasEventListener (type: string){
        return this._eventProcessor.hasEventListener(type);
    }

    public targetOff (target: string | Object) {
        this._eventProcessor.targetOff(target);
        // Check for event mask reset
        if ((this._eventMask & TRANFORM_ON) && !this._eventProcessor.hasEventListener(SystemEventType.TRANSFORM_CHANGED)) {
            this._eventMask &= ~TRANFORM_ON;
        }
    }

    public pauseSystemEvents (recursive: boolean) {
        eventManager.pauseTarget(this, recursive);
    }

    public resumeSystemEvents (recursive: boolean) {
        eventManager.resumeTarget(this, recursive);
    }

    public _onPreDestroy () {
        this._eventProcessor.destroy();
        super._onPreDestroy();
    }
}

cc.Node = Node;