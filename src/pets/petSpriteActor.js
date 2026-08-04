import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    getPetDefinition,
    getPetDisplayScale,
    getPetSpriteCandidates,
    getPetStageByKey,
    parsePetForm,
} from './petCollection.js';

const IDLE_FRAME_MS = 800;
const SLEEP_DELAY_MS = 30_000;
const PET_STAGE_CLASSES = [
    'katab-pet-sprite-stage-egg',
    'katab-pet-sprite-stage-hatchling',
    'katab-pet-sprite-stage-sprout',
    'katab-pet-sprite-stage-scholar',
    'katab-pet-sprite-stage-sage',
    'katab-pet-sprite-stage-archmage',
];

const ASSET_PATH_CACHE = new Map();
const GICON_CACHE = new Map();

export const PetSpriteActor = GObject.registerClass(
class PetSpriteActor extends St.Widget {
    _init(extensionPath, { slotSize = 112, animate = true, fallbackText = '?' } = {}) {
        super._init({
            style_class: 'katab-pet-sprite',
            width: slotSize,
            height: slotSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });

        this._extensionPath = extensionPath;
        this._slotSize = slotSize;
        this._animate = animate;
        this._fallbackText = fallbackText;
        this._form = null;
        this._stageKey = 'egg';
        this._pose = 'idle';
        this._frame = 1;
        this._idleSourceId = 0;
        this._poseSourceId = 0;
        this._sleepSourceId = 0;

        this._image = new St.Icon({
            style_class: 'katab-pet-sprite-image',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._image);

        this._fallback = new St.Label({
            text: fallbackText,
            style_class: 'katab-pet-sprite-fallback',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._fallback);

        this.connect('notify::mapped', () => this._syncAnimation());
        this.connect('destroy', () => this._clearTimers());
    }

    setCompanion(companion, { pose = 'idle' } = {}) {
        const form = parsePetForm(companion?.id);
        if (!form) return;

        this._form = form;
        this._stageKey = companion.stageKey || 'egg';
        this._pose = pose;
        this._frame = 1;
        this._fallbackText = companion.fallbackText || this._fallbackText;
        this._fallback.set_text(this._fallbackText);
        this.accessible_name = `${companion.name || 'Pet'}, ${companion.stageLabel || 'Unhatched Egg'}`;
        this._render();
        this._syncAnimation();
    }

    showPose(pose, durationMs = 0) {
        if (!this._form) return;
        this._clearPoseTimer();
        this._clearSleepTimer();
        this._pose = pose;
        this._frame = 1;
        this._render();
        this._syncAnimation();

        if (durationMs > 0 && pose !== 'idle') {
            this._poseSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
                this._poseSourceId = 0;
                this._pose = 'idle';
                this._frame = 1;
                this._render();
                this._syncAnimation();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _render() {
        if (!this._form) return;
        const relativeCandidates = getPetSpriteCandidates({
            form: this._form,
            stageKey: this._stageKey,
            pose: this._pose,
            frame: this._frame,
        });
        const assetPath = resolveAssetPath(this._extensionPath, relativeCandidates);
        const stage = getPetStageByKey(this._stageKey);
        const nativeSize = stage.spriteFamily === 'adult' ? this._slotSize : Math.min(64, this._slotSize);
        this._image.icon_size = Math.round(nativeSize * getPetDisplayScale(this._stageKey));

        for (const className of PET_STAGE_CLASSES) this.remove_style_class_name(className);
        this.add_style_class_name(`katab-pet-sprite-stage-${stage.key}`);

        if (assetPath) {
            this._image.gicon = getFileIcon(assetPath);
            this._image.show();
            this._fallback.hide();
        } else {
            this._image.hide();
            this._fallback.show();
        }
    }

    _syncAnimation() {
        this._clearIdleTimer();
        this._clearSleepTimer();
        this._scheduleSleep();
        if (!this._shouldAnimate()) return;

        this._idleSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDLE_FRAME_MS, () => {
            if (!this._shouldAnimate()) {
                this._idleSourceId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._frame = this._frame === 1 ? 2 : 1;
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _shouldAnimate() {
        if (!this._animate || !this._form || this._pose !== 'idle' || !this.is_mapped()) return false;
        try {
            return St.Settings.get().enable_animations;
        } catch (_e) {
            return true;
        }
    }

    _clearTimers() {
        this._clearIdleTimer();
        this._clearPoseTimer();
        this._clearSleepTimer();
    }

    _clearIdleTimer() {
        if (!this._idleSourceId) return;
        GLib.source_remove(this._idleSourceId);
        this._idleSourceId = 0;
    }

    _clearPoseTimer() {
        if (!this._poseSourceId) return;
        GLib.source_remove(this._poseSourceId);
        this._poseSourceId = 0;
    }

    _scheduleSleep() {
        if (!this._animate || !this._form || !this.is_mapped() || this._pose !== 'idle' || this._stageKey === 'egg') return;
        this._sleepSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLEEP_DELAY_MS, () => {
            this._sleepSourceId = 0;
            if (!this.is_mapped() || this._pose !== 'idle') return GLib.SOURCE_REMOVE;
            this._pose = 'sleep';
            this._frame = 1;
            this._render();
            this._clearIdleTimer();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearSleepTimer() {
        if (!this._sleepSourceId) return;
        GLib.source_remove(this._sleepSourceId);
        this._sleepSourceId = 0;
    }
});

function resolveAssetPath(extensionPath, relativeCandidates) {
    const cacheKey = `${extensionPath}\u0000${relativeCandidates.join('\u0000')}`;
    if (ASSET_PATH_CACHE.has(cacheKey)) return ASSET_PATH_CACHE.get(cacheKey);

    for (const relativePath of relativeCandidates) {
        const absolutePath = `${extensionPath}/${relativePath}`;
        if (Gio.File.new_for_path(absolutePath).query_exists(null)) {
            ASSET_PATH_CACHE.set(cacheKey, absolutePath);
            return absolutePath;
        }
    }

    ASSET_PATH_CACHE.set(cacheKey, null);
    return null;
}

function getFileIcon(path) {
    if (!GICON_CACHE.has(path)) GICON_CACHE.set(path, Gio.icon_new_for_string(path));
    return GICON_CACHE.get(path);
}