/** Brood War: main menu → Multiplayer → Expansion; standard.snp (LAN IPX/UDP) must load with no unimplemented thunks. */
import { harness } from "../harness";

const result = await harness()
    .openWgb("/apps/starcraft_retail.wgb")
    .sleep(25000)
    .clickAt(140, 210).sleep(3000)
    .clickAt(370, 290).sleep(8000)
    .shot({ save: "sc-retail-connections.png" })
    .stubs()
    .state(["modules"])
    .run();

console.log(JSON.stringify(result, (k, v) => k === "base64" ? undefined : v, 2));
