// props — the Properties panel: KiCad's symbol / footprint / item property
// dialogs as a live side panel of the web editor.
//
// The node editors (helpers.ts and the modules it gathers) only touch the raw
// s-expression array, so they also run under node for the tests; everything
// that needs a DOM sits in panel.ts and is only reached from render().  Every
// edit works on a clone of the item's node and commits one whole-item replace
// change, so app.js can record the untouched original as the undo step.
//
// Built by 'npm run build:props' into static/props.js, a classic script (IIFE)
// that registers window.CollabTools.props.
"use strict";
import { exportToNode, root } from "../root";
import { helpers } from "./helpers";
import { KIND_NAMES, inspect, refresh, render, renderInto } from "./panel";

const props = { render, refresh, inspect, renderInto, helpers, KIND_NAMES };
/** window.CollabTools.props */
export type PropsApi = typeof props;

root.CollabTools = root.CollabTools || {};
root.CollabTools.props = props;
exportToNode(root.CollabTools.props);
