// Bootstrap: on first /_app/meta hit (or cold start), deploy BPMN, DMN, forms,
// and DoDAF views to the platform registries via service binding to PDS.
// Idempotent: deployments are keyed by (did, processKey|decisionKey|formKey|viewId).
//
// In standalone mode (no PDS binding), this is a no-op.

import OV1 from "../../dodaf/OV-1.json";
import OV5b from "../../dodaf/OV-5b.json";
import OV6a from "../../dodaf/OV-6a.json";
import CV2 from "../../dodaf/CV-2.json";
import SV1 from "../../dodaf/SV-1.json";
import AV1 from "../../dodaf/AV-1.json";
import openAccountForm from "../../forms/openAccount.form.json";
import transferForm from "../../forms/transfer.form.json";

export interface BootstrapEnv {
  PDS?: Fetcher;
  PRIMARY_DID: string;
}

const BPMN_FILES = [
  { key: "openAccount", path: "bpmn/open-account.bpmn" },
  { key: "transfer",    path: "bpmn/transfer.bpmn" },
];
const DMN_FILES = [
  { key: "openBanking.transferEligibility", path: "dmn/transfer-eligibility.dmn" },
];
const FORMS = [openAccountForm, transferForm];
const DODAF_VIEWS = [AV1, OV1, OV5b, OV6a, CV2, SV1];

async function xrpc(pds: Fetcher, nsid: string, body: unknown): Promise<Response> {
  return pds.fetch(`https://atproto.gftd.ai/xrpc/${nsid}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let bootstrapped = false;

export async function bootstrapDodaf(env: BootstrapEnv, bpmnLoader?: (path: string) => Promise<string>) {
  if (bootstrapped || !env.PDS) return { skipped: true };
  bootstrapped = true;

  const did = env.PRIMARY_DID;
  const errors: string[] = [];

  // DoDAF views — deploy first (they describe the system)
  for (const view of DODAF_VIEWS) {
    try {
      await xrpc(env.PDS, "ai.gftd.dodafv2.deployView", { did, ...view });
    } catch (e: any) { errors.push(`dodafv2.deployView ${(view as any).viewId}: ${e?.message}`); }
  }

  // BPMN — requires raw XML, loader must be provided by the caller that has fs/assets
  if (bpmnLoader) {
    for (const b of BPMN_FILES) {
      try {
        const bpmnXml = await bpmnLoader(b.path);
        await xrpc(env.PDS, "ai.gftd.bpmn.deployProcess", { did, bpmnXml });
      } catch (e: any) { errors.push(`bpmn.deployProcess ${b.key}: ${e?.message}`); }
    }
  }

  // Forms
  for (const f of FORMS) {
    try {
      await xrpc(env.PDS, "ai.gftd.form.register", { did, ...f });
    } catch (e: any) { errors.push(`form.register ${(f as any).formKey}: ${e?.message}`); }
  }

  return { ok: errors.length === 0, errors };
}
