import { runDeepSeekLiveEval } from "./deepseek-live-eval";
import { loadRepositoryEnv } from "./local-env";

loadRepositoryEnv();

try {
  const result = await runDeepSeekLiveEval();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "DeepSeek Eval 执行失败");
  process.exitCode = 1;
}
