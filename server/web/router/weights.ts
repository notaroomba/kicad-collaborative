// Autorouter — the scoring weights.  The values in TRAINED are written by `node scripts/router-train.mjs`, which
// fits them so that the tracks people drew on the reference boards score better than the alternatives the router
// would have considered for the same connection.  Nothing here is a model: it is seven numbers and a provenance note.
export interface Weights {
  length: number;      // per mm of track
  via: number;         // per via
  bend45: number;      // per 45° corner
  bend90: number;      // per 90° corner
  wrongDir: number;    // per mm run against the layer's prevailing direction
  viaLevel: number;    // how many corners a via counts for while the search widens
  extraLevels: number; // how many more corners than the simplest route the search still considers
  mitre: number;       // longest chamfer cut into a forced 90° corner, mm
}

export const DEFAULT_WEIGHTS: Weights = { length: 1, via: 6, bend45: 0.6, bend90: 2.5, wrongDir: 0.3, viaLevel: 2, extraLevels: 2, mitre: 1.2 };

/** What the weights were fitted on (filled in by the trainer). */
export interface Provenance { boards: { name: string; source: string; license: string; connections: number }[]; fitted: string; agreement: number }

// <trained>
export const TRAINED: Weights = {"length":1,"via":4.66,"bend45":0.05,"bend90":3.13,"wrongDir":0,"viaLevel":1,"extraLevels":2,"mitre":1.22};
export const PROVENANCE: Provenance = {
  "boards": [
    {
      "name": "Glasgow Interface Explorer revC3",
      "source": "https://github.com/GlasgowEmbedded/glasgow",
      "license": "0BSD OR Apache-2.0",
      "connections": 120
    },
    {
      "name": "HackRF One",
      "source": "https://github.com/greatscottgadgets/hackrf",
      "license": "GPL-2.0",
      "connections": 148
    },
    {
      "name": "Libre Solar BMS C1",
      "source": "https://github.com/LibreSolar/bms-c1",
      "license": "CERN-OHL-W-2.0",
      "connections": 121
    },
    {
      "name": "System76 Launch Heavy",
      "source": "https://github.com/system76/launch",
      "license": "GPL-3.0",
      "connections": 30
    },
    {
      "name": "LumenPnP motherboard",
      "source": "https://github.com/opulo-inc/lumenpnp",
      "license": "CERN-OHL-W-2.0",
      "connections": 122
    },
    {
      "name": "LumenPnP ring light",
      "source": "https://github.com/opulo-inc/lumenpnp",
      "license": "CERN-OHL-W-2.0",
      "connections": 26
    },
    {
      "name": "LumenPnP feeder",
      "source": "https://github.com/opulo-inc/lumenpnp",
      "license": "CERN-OHL-W-2.0",
      "connections": 74
    }
  ],
  "fitted": "2026-11-11",
  "agreement": 0.85
};
// </trained>
