// toolModes.js — shared Auto/On/Off mode constants for mode-controlled tools
// (Web Search, Web Crawler, Deep Research) plus their popup label maps.
//
// Single source for the mode vocabulary: the dialog's mode cycling logic and
// the tools-popup UI module both import from here.

export const TOOL_MODE_AUTO = 'auto';
export const TOOL_MODE_ON = 'on';
export const TOOL_MODE_OFF = 'off';
export const TOOL_MODE_SEQUENCE = [TOOL_MODE_AUTO, TOOL_MODE_ON, TOOL_MODE_OFF];
export const TOOL_MODE_LABELS = {
    [TOOL_MODE_AUTO]: 'Auto',
    [TOOL_MODE_ON]: 'On',
    [TOOL_MODE_OFF]: 'Off',
};

// Deep Research is a binary toggle (On/Off) — "Auto" doesn't make sense
// for a comprehensive multi-step research pipeline.
export const DEEP_RESEARCH_MODE_SEQUENCE = [TOOL_MODE_OFF, TOOL_MODE_ON];
export const DEEP_RESEARCH_MODE_LABELS = {
    [TOOL_MODE_ON]: 'On',
    [TOOL_MODE_OFF]: 'Off',
};
