import { TavilySearch, PublicPageReader } from "@job-research/research-tools";
export async function runResearchLiveSmoke(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.JRA_RUN_RESEARCH_LIVE !== "1") throw new Error("Set JRA_RUN_RESEARCH_LIVE=1 to explicitly permit network usage");
  const signal = AbortSignal.timeout(60_000);
  const search = new TavilySearch(environment.TAVILY_API_KEY ?? "");
  const results = await search.search("Mozilla official organization about", signal);
  const first = results[0]; if (!first) throw new Error("Search returned no sources");
  const page = await new PublicPageReader().read(first.url, signal);
  if (page.status !== "ok") throw new Error(`Page read: ${page.reason}`);
  return { sourceCount: results.length, readMethod: page.method, characters: page.text.length };
}
