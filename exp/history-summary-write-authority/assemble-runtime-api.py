import json
from pathlib import Path

root = Path("/home/xp/src/copilot-api-js/.worktree/agent-a0b5eee4b161ab9ab")
exp = root / "exp/history-summary-write-authority"
bun = json.loads((exp / "bun-runtime.json").read_text())
node = json.loads((exp / "node-runtime.json").read_text())
node_driver = json.loads((exp / "node-driver-runtime.json").read_text())
bun_types = Path("/home/xp/src/copilot-api-js/node_modules/bun-types/sqlite.d.ts").read_text()
node_types = Path("/home/xp/src/copilot-api-js/node_modules/@types/node/sqlite.d.ts").read_text()
record = {
    "scope": "Step A: public runtime/type/adapter API inventory only",
    "worktree": str(root),
    "headBeforeStep": "0514af09c89beed4d2b00c13119c18861bc6103e",
    "commands": [
        "bun exp/history-summary-write-authority/probe-bun.ts",
        "node exp/history-summary-write-authority/probe-node.mjs",
        "node exp/history-summary-write-authority/probe-driver-node.mjs",
        "rg -n 'function|scalar|aggregate|authoriz|update|preupdate|loadExtension|serialize|deserialize|transaction' /home/xp/src/copilot-api-js/node_modules/bun-types/sqlite.d.ts",
        "rg -n 'function|aggregate|Authorizer|authorizer|update|preupdate|loadExtension|serialize|deserialize|transaction' /home/xp/src/copilot-api-js/node_modules/@types/node/sqlite.d.ts",
    ],
    "bun": bun,
    "node": node,
    "installedTypeDeclarations": {
        "bun": {
            "package": "@types/bun 1.3.14 (resolves to bun-types/sqlite.d.ts)",
            "file": "/home/xp/src/copilot-api-js/node_modules/bun-types/sqlite.d.ts",
            "candidateDeclared": {
                "function": False,
                "scalar": False,
                "aggregate": False,
                "setAuthorizer": False,
                "authorizer": False,
                "updateHook": False,
                "update_hook": False,
                "preupdateHook": False,
                "preupdate_hook": False,
                "loadExtension": "loadExtension(" in bun_types,
                "serialize": "serialize(name?" in bun_types,
                "deserialize": "static deserialize(" in bun_types,
                "transaction": "transaction<A extends any[], T>" in bun_types,
            },
            "notes": ["Bun deserialize is static Database.deserialize, not an instance method."],
        },
        "node": {
            "package": "@types/node 24.6.2 bundled transitively; older than the installed Node v24.16.0 runtime API surface",
            "file": "/home/xp/src/copilot-api-js/node_modules/@types/node/sqlite.d.ts",
            "candidateDeclared": {
                "function": "function(name:" in node_types,
                "scalar": False,
                "aggregate": "aggregate(name:" in node_types,
                "setAuthorizer": "setAuthorizer(" in node_types,
                "authorizer": False,
                "updateHook": False,
                "update_hook": False,
                "preupdateHook": False,
                "preupdate_hook": False,
                "loadExtension": "loadExtension(path:" in node_types,
                "serialize": "serialize(" in node_types,
                "deserialize": "deserialize(" in node_types,
                "transaction": False,
            },
            "notes": [
                "Node DatabaseSync.function is the scalar UDF registration API; there is no separate scalar method.",
                "Installed @types/node 24.6.2 declares function/aggregate/loadExtension but does not yet declare runtime-present setAuthorizer/serialize/deserialize; runtime reflection and execution are authoritative for Node v24.16.0.",
                "Node has no transaction callback helper.",
            ],
        },
    },
    "projectBackend": {
        "source": "packages/foundation/src/sqlite/driver.ts",
        "bun": "bun:sqlite.Database selected when globalThis.Bun exists",
        "node": "node:sqlite.DatabaseSync selected otherwise",
        "nodeRealProcessSmoke": node_driver,
        "dependencies": "No third-party SQLite package is declared in root or foundation package manifests.",
    },
    "unifiedDriverSurface": {
        "database": ["exec(sql)", "prepare(sql)", "close()", "transaction(fn)"],
        "statement": ["all(...params)", "get(...params)", "run(...params)"],
        "openOptions": ["readonly"],
        "missingComparedWithNodePublicSurface": [
            "function",
            "aggregate",
            "setAuthorizer",
            "loadExtension",
            "serialize",
            "deserialize",
        ],
        "missingComparedWithBunPublicSurface": ["loadExtension", "serialize", "static Database.deserialize"],
        "commonNativeRegistrationGap": "Bun 1.3.14 exposes no public scalar/function, aggregate, or authorizer registration API, while Node 24.16.0 does.",
    },
    "notProven": [
        "No trigger or controlled maintenance mode was implemented or exercised.",
        "Absence from public prototype and installed declarations does not prove native internals cannot be reached by unsupported means.",
        "loadExtension presence does not prove an extension can be built or loaded in both runtimes.",
        "No update/preupdate hook behavior, second connection behavior, nested scope, reentrancy, or exception cleanup was tested.",
    ],
}
(exp / "runtime-api.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
