// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
/** The editor's mutable state — every former top-level `let` of the original script, referenced as E.<name>. */
export const E: any = {
  toastN: 0,
  ws: null,
  retries: 0,
  canJoin: false,
  viewOnly: false,
  canComment: false,   // commenter or editor, and signed in (server/src/access.rs decides; this is what the interface offers)
  overrideLocks: false,   // the aux bar's "Override locks": locked board items may be moved, turned, flipped and deleted
  myClientId: "",
  wsToken: "",
  IU: 1e6,
  vbPerMm: 1,
  DOC_TYPE: "kicad_pcb",
  ITEM_TYPE: "FOOTPRINT",
  sheets: [],
  vb: [0, 0, 297, 210],
  items: [],
  selected: null,
  drag: null,
  pan: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  tool: "select",
  editsSeen: 0,
  opN: 0,
  lastPresence: 0,
  lastPresenceMm: null,
  presenceTimer: 0,
  // Ops we have applied locally and sent (or made offline) that the server has not acked yet;
  // clientOpId -> {docId, changes}.  Replayed on every (re)join — see net.ts replayPending.
  pendingOps: new Map(),
  joinedDocId: null,
  lastSeq: 0,
  // the text the open document was parsed from and the op counter at that moment, until the live session's
  // first snapshot arrives (net.ts: an identical snapshot is not parsed again)
  loadedText: null,
  loadedOpN: 0,
  loadedSeq: 0,   // the seq the loaded document stands at: the snapshot's, or the last edit openDoc applied on top

  resyncAt: 0,
  applyFailed: false,
  lastLiveMove: 0,
  followPeer: null,
  suppressBreakout: false,
  peerState: {},
  comments: [],
  openThread: null,
  pendingThread: null,   // a thread to open once its document has loaded (comments.ts)
  layers: {},
  renderTimer: 0,
  renderDirtySince: 0,
  baseVersion: 0,
  kdoc: null,
  hiddenLayers: new Set(),
  layersSeeded: false,
  gridOn: true,
  snapOn: true,
  gridPitch: 1.27,
  localOrigin: [0, 0],
  lastCursorMm: [0, 0],
  lastClient: null,   // the pointer's last client position over the canvas (where a Clarify Selection popup opens)
  hooks: {},          // candidatesAt / clarify / handoffDrag / selectionKeys (menu-actions.ts: ids + picked pads) for the tool modules' hover selection (contextmenu.ts, gestures.ts)
  polarCoords: false,
  crosshairMode: "small",
  renderOpts: {},
  measure: null,
  zoomRect: null,
  activeLayer: "",
  markers: [],
  proSettings: null,
  druText: null,
  selection: new Set(),
  selMode: "rect",
  boxSel: null,
  highlightIds: null,
  selField: null,
  selPins: [],    // bare symbol pins [{id, number}] (SCH_PIN_T selected on their own; Shift / Ctrl+click adds and toggles)
  fdrag: null,
  renderReq: 0,
  lastStageW: 0,
  viewTouched: false,
  lastFpHit: null,
  connectGen: 0,
  panes: {},
  units: "mm",
  lastImperial: "mil",   // COMMON_TOOLS::m_imperialUnit: Ctrl+U returns to it, metric lists show it second
};
((typeof window !== "undefined" ? window : globalThis) as unknown as { CollabEditor: unknown })["CollabEditor"] = E;
