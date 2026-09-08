import { ResearchRepository } from "@job-research/database";
import { FakeSearch, FakePageReader, TavilySearch, PublicPageReader } from "@job-research/research-tools";
import { DeepResearchApplication, createDeepResearchHandler } from "./deep-research";
import { applyMigrations, BusinessRepository, JobRepository, openDatabase } from "@job-research/database";
import { createModelRuntimeFromEnv } from "@job-research/model-gateway";
import { buildServer } from "./app";
import { HandlerRegistry, LocalJobWorker } from "./worker";
import { createExtractionHandler, createScreeningHandler, LocalIngestionApplication, LocalOpportunityApplication, LocalProfileApplication, LocalResearchApplication } from "./business-app";
import { modelConfigFromDescriptor } from "./model-prompts";
import { loadRepositoryEnv } from "./local-env";

loadRepositoryEnv();

const connection = openDatabase();
applyMigrations(connection.sqlite);

const repository = new JobRepository(connection.sqlite);
const businessRepository = new BusinessRepository(connection.sqlite);
const modelRuntime = createModelRuntimeFromEnv(process.env);
const modelConfig = modelConfigFromDescriptor(modelRuntime.selected.descriptor);
const profile = new LocalProfileApplication(businessRepository);
const ingestion = new LocalIngestionApplication(businessRepository, repository, undefined, modelConfig);
const opportunities = new LocalOpportunityApplication(businessRepository);
const research = new LocalResearchApplication(businessRepository, repository, undefined, modelConfig);
const researchMode = process.env.JRA_RESEARCH_MODE?.trim() || "demo";
if (!["demo", "live"].includes(researchMode)) throw new Error("JRA_RESEARCH_MODE must be demo or live");
if (researchMode === "live" && modelConfig.provider === "local") throw new Error("Live research requires a real model provider");
const deepResearch = new DeepResearchApplication({ repository: new ResearchRepository(businessRepository), jobs: repository, search: researchMode === "live" ? new TavilySearch(process.env.TAVILY_API_KEY ?? "") : new FakeSearch(), reader: researchMode === "live" ? new PublicPageReader() : new FakePageReader(), models: modelRuntime.resolver, mode: researchMode as "demo" | "live", ...(researchMode === "live" ? { modelConfig } : {}) });
const registry = new HandlerRegistry()
  .register("extract-job-draft", createExtractionHandler(businessRepository, modelRuntime.resolver))
  .register("screen-opportunity", createScreeningHandler(businessRepository, modelRuntime.resolver))
  .register("deep-research", createDeepResearchHandler(deepResearch));
const workers = [
  new LocalJobWorker({ repository, registry, jobTypes: ["extract-job-draft", "screen-opportunity"] }),
  new LocalJobWorker({ repository, registry, jobTypes: ["extract-job-draft", "screen-opportunity"] }),
  new LocalJobWorker({ repository, registry, jobTypes: ["deep-research"] }),
];
const wakeResearch = setInterval(() => deepResearch.wakeWaiting(), 1000);
wakeResearch.unref();
const app = buildServer({
  repository,
  deepResearch,
  databaseHealth: () => {
    try {
      connection.sqlite.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  },
  workerHealth: () => workers.every(worker => worker.isRunning),
  business: { repository: businessRepository, profile, ingestion, opportunities, research },
});

const host = process.env.JRA_HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.JRA_PORT ?? "4310", 10);

for (const worker of workers) worker.start();
await app.listen({ host, port });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  clearInterval(wakeResearch);
  await Promise.all(workers.map(worker => worker.stop()));
  connection.close();
};

const handleSignal = () => {
  void shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
};

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);
