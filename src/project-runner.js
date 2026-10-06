import { runCommand } from './runner.js';
import { failureSignature } from './failure-signature.js';
import { detectPackageManager, discoverNpm, npmInstall, npmEnvironment, commandUsesNpm } from './package-manager.js';

// Caller supplies an isolated workspace; this helper never selects a source cwd.
export async function executeProject(workspace, cwd, files, { command, npmPath, timeoutMs = 10_000, installTimeoutMs = 60_000, offline = false, allowInstallScripts = false, onRun = () => {}, executionEnv = {} }) {
  const manager = await detectPackageManager(cwd, files);
  const npm = manager.needsInstall || commandUsesNpm(command) ? await discoverNpm({ npmPath, cwd }) : null;
  if (manager.needsInstall) await npmInstall({ cwd, npm, timeoutMs: installTimeoutMs, offline, allowInstallScripts });
  const env = npm ? await npmEnvironment(npm, workspace.root) : {};
  onRun();
  const result = await runCommand({ cwd, command, timeoutMs, env: {...env,...executionEnv} });
  return { result, signature: failureSignature(result, { roots: [cwd] }), cwd, env, installed: manager.needsInstall };
}
