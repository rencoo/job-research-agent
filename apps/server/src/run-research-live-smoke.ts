import { loadRepositoryEnv } from "./local-env";
import { runResearchLiveSmoke } from "./research-live-smoke";
loadRepositoryEnv();
console.log(await runResearchLiveSmoke());
