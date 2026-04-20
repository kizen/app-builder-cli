import { useParams, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { type FC, useEffect, useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';
import { CodeViewer, type ExecutionMode } from '../components/CodeViewer.js';
import { ExecutionResultPanel, type ExecutionResult } from '../components/ExecutionResultPanel.js';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { executeRemoteStep } from '../remoteRunner.js';
import type { DeployablePlugin } from '@kizenapps/packager';
import { loadConfig, loadUserConfig } from '../lib/configStorage.js';
import { WhenBadge } from '../components/WhenBadge.js';
import type { PluginBaseConfig } from '../types.js';
import type { UnknownJSON } from '@kizenapps/engine';
import { mergeConfig } from '@kizenapps/engine/util';

export const CodeStepsPage: FC = () => {
  const { apiName, stepApiName } = useParams({ strict: false });
  const navigate = useNavigate();

  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);
  const request = useApi();

  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  const inputsKey = `kizen-step-inputs:${apiName ?? ''}:${stepApiName ?? ''}`;
  const [inputValues, setInputValues] = useLocalStorage<Record<string, string>>(inputsKey, {});

  const secretsKey = `kizen-step-secrets:${apiName ?? ''}:${stepApiName ?? ''}`;
  const [secretValues, setSecretValues] = useLocalStorage<Record<string, string>>(secretsKey, {});

  const [executionMode, setExecutionMode] = useLocalStorage<ExecutionMode>(
    'kizen-code-runner-mode',
    'local',
  );

  const app = bundle?.find((a) => a.api_name === apiName) as DeployablePlugin | undefined;

  const steps = useMemo(() => app?.artifacts.automation_action_configs ?? [], [app]);
  const selectedStep = steps.find((s) => s.action_step_api_name === stepApiName) ?? steps[0];

  const whenState = useMemo((): Record<string, UnknownJSON> => {
    if (!apiName || !app) {
      return {};
    }

    const baseConfig = app.base_config as PluginBaseConfig | undefined;
    const stored = loadConfig(apiName);
    const storedUser = loadUserConfig(apiName);

    const mergedConfig = mergeConfig(
      (stored?.__kizen_clean_config ?? {}) as Record<string, UnknownJSON>,
      [],
      (stored?.__kizen_setup_assistant_values ?? {}) as Record<string, UnknownJSON>,
      baseConfig?.setup_assistant?.fields,
    );
    const mergedUserConfig = mergeConfig(
      (storedUser?.__kizen_clean_config ?? {}) as Record<string, UnknownJSON>,
      [],
      (storedUser?.__kizen_setup_assistant_values ?? {}) as Record<string, UnknownJSON>,
      baseConfig?.user_setup_assistant?.fields,
    );

    const state: Record<string, UnknownJSON> = {};

    for (const [k, v] of Object.entries(mergedConfig)) {
      state[`config__${k}`] = v;
    }

    for (const [k, v] of Object.entries(mergedUserConfig)) {
      state[`userConfig__${k}`] = v;
    }

    return state;
  }, [apiName, app]);

  // Auto-redirect to first step when no step is selected
  useEffect(() => {
    if (!stepApiName && steps.length > 0 && apiName) {
      const first = steps[0];

      if (first) {
        void navigate({
          to: '/$apiName/code-steps/$stepApiName',
          params: { apiName, stepApiName: first.action_step_api_name },
          replace: true,
        });
      }
    }
  }, [stepApiName, steps, apiName, navigate]);

  // Clear result when switching steps
  useEffect(() => {
    setResult(null);
  }, [stepApiName]);

  if (isLoading) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-400">Fetching bundle.json…</p>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-red-700">Could not load bundle.json.</p>
      </Card>
    );
  }

  if (!app) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-500">
          No app found with api_name{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5">{apiName}</code>.
        </p>
      </Card>
    );
  }

  if (steps.length === 0) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-500">This app has no automation code steps.</p>
      </Card>
    );
  }

  if (!selectedStep) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-500">
          Step not found: <code className="rounded bg-neutral-100 px-1 py-0.5">{stepApiName}</code>.
        </p>
      </Card>
    );
  }

  const handleRun = async (): Promise<void> => {
    setIsRunning(true);
    setResult(null);

    try {
      const definedInputs = Object.fromEntries(
        selectedStep.inputs.map((i) => [i.name, inputValues[i.name] ?? '']),
      );

      let data: ExecutionResult;

      if (executionMode === 'remote') {
        data = await executeRemoteStep(request, {
          script: selectedStep.script,
          scriptRuntime: selectedStep.script_runtime,
          inputs: definedInputs,
          inputTypes: Object.fromEntries(selectedStep.inputs.map((i) => [i.name, i.data_type])),
          outputTypes: Object.fromEntries(selectedStep.outputs.map((o) => [o.name, o.data_type])),
          secretNames: selectedStep.secrets.map((s) => `${apiName ?? ''}__${s}`),
        });
      } else {
        const res = await fetch('/api/execute-step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script: selectedStep.script,
            scriptRuntime: selectedStep.script_runtime,
            inputs: definedInputs,
            secrets: Object.fromEntries(
              selectedStep.secrets.map((s) => [`${apiName ?? ''}__${s}`, secretValues[s] ?? '']),
            ),
          }),
        });

        data = (await res.json()) as ExecutionResult;
      }

      setResult(data);
    } catch (err) {
      setResult({
        success: false,
        outputValues: {},
        logs: [],
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: 0,
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Code Step
          </span>
          <select
            value={selectedStep.action_step_api_name}
            onChange={(e) => {
              if (apiName) {
                void navigate({
                  to: '/$apiName/code-steps/$stepApiName',
                  params: { apiName, stepApiName: e.target.value },
                });
              }
            }}
            className="rounded border border-black/10 bg-transparent px-2 py-0.5 text-[13px] font-mono text-neutral-700 focus:outline-none"
          >
            {steps.map((step) => (
              <option key={step.action_step_api_name} value={step.action_step_api_name}>
                {step.name}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
            {selectedStep.script_runtime}
          </span>
        </div>
        {selectedStep.overall_description && (
          <p className="mt-2 text-[12px] text-neutral-500">{selectedStep.overall_description}</p>
        )}
        {(selectedStep as typeof selectedStep & { when?: string }).when && (
          <div className="mt-2">
            <WhenBadge
              when={(selectedStep as typeof selectedStep & { when?: string }).when}
              whenState={whenState}
            />
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Inputs
          </div>
          {selectedStep.inputs.length > 0 ? (
            <div className="space-y-3">
              {selectedStep.inputs.map((input) => (
                <div key={input.name}>
                  <label className="mb-1 block text-[12px] text-neutral-700">
                    {input.label}
                    {input.required && <span className="ml-0.5 text-red-500">*</span>}
                  </label>
                  <input
                    type="text"
                    value={inputValues[input.name] ?? ''}
                    onChange={(e) => {
                      setInputValues({ ...inputValues, [input.name]: e.target.value });
                    }}
                    placeholder={input.name}
                    className="w-full rounded border border-black/10 bg-white px-2.5 py-1.5 font-mono text-[13px] text-neutral-800 placeholder:text-neutral-300 focus:border-blue-300 focus:outline-none"
                  />
                  <div className="mt-0.5 font-mono text-[10px] text-neutral-400">{input.name}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-neutral-400">None defined.</p>
          )}
        </Card>

        <Card>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Outputs
          </div>
          {selectedStep.outputs.length > 0 ? (
            <div className="space-y-2">
              {selectedStep.outputs.map((output) => (
                <div
                  key={output.name}
                  className="flex items-baseline gap-2 rounded border border-black/5 bg-neutral-50 px-2.5 py-1.5"
                >
                  <span className="text-[13px] text-neutral-700">{output.label}</span>
                  <span className="font-mono text-[10px] text-neutral-400">{output.name}</span>
                  <span className="ml-auto rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                    {output.data_type}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-neutral-400">None defined.</p>
          )}
        </Card>

        <Card>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Secrets
          </div>
          {executionMode === 'remote' && (
            <p className="mb-3 rounded border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-[12px] text-blue-700">
              Remote runner uses secrets from your business context.
            </p>
          )}
          {selectedStep.secrets.length > 0 ? (
            <div className="space-y-3">
              {selectedStep.secrets.map((secret) => (
                <div key={secret}>
                  <label className="mb-1 block text-[12px] text-neutral-700">{secret}</label>
                  <input
                    type="password"
                    value={secretValues[secret] ?? ''}
                    onChange={(e) => {
                      setSecretValues({ ...secretValues, [secret]: e.target.value });
                    }}
                    placeholder={secret}
                    disabled={executionMode === 'remote'}
                    className="w-full rounded border border-black/10 bg-white px-2.5 py-1.5 font-mono text-[13px] text-neutral-800 placeholder:text-neutral-300 focus:border-blue-300 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-neutral-400">None defined.</p>
          )}
        </Card>
      </div>

      <CodeViewer
        code={selectedStep.script}
        language="python"
        onRun={() => void handleRun()}
        isRunning={isRunning}
        executionMode={executionMode}
        onModeChange={setExecutionMode}
      />

      {result && <ExecutionResultPanel result={result} />}
    </div>
  );
};
