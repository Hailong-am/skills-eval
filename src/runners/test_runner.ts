/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable jest/no-export */

import fs from 'fs';
import fsPromises from 'node:fs/promises';
import path from 'path';
import { ApiProvider } from 'promptfoo';

export interface TestSpec {
  id: string;
  clusterStateId: string;
}

export interface TestResult extends jest.CustomMatcherResult {
  score: number;
  /**
   * any other information that should be persisted
   */
  extras?: Record<string, unknown>;
}

export abstract class TestRunner<
  T extends TestSpec = TestSpec,
  U extends ApiProvider = ApiProvider,
> {
  private resultsFilePath?: string;
  private persistedMetadata: { score: number; pass: boolean }[] = [];

  constructor(private readonly apiProvider: ApiProvider) {
    this.apiProvider = apiProvider as U;
  }

  protected async beforeAll(clusterStateId: string): Promise<void> {}
  protected async afterAll(clusterStateId: string): Promise<void> {}
  protected async beforeEach(clusterStateId: string): Promise<void> {}
  protected async afterEach(clusterStateId: string): Promise<void> {}

  /**
   * Build prompt and context to call api provider from each test case.
   *
   * @param spec test case
   * @returns prompt and context
   */
  protected abstract buildInput(spec: T): {
    prompt: Parameters<ApiProvider['callApi']>[0];
    context: Parameters<ApiProvider['callApi']>[1];
  };

  /**
   * Compares actual and expected response.
   *
   * @param received the returned response from api provider
   * @param spec test case used
   * @returns comparison result
   */
  public abstract compareResults(
    received: Awaited<ReturnType<U['callApi']>>,
    spec: T,
  ): Promise<TestResult>;

  /**
   * Runs the test case using api provider.
   *
   * @param spec the test case
   * @returns api provider response
   */
  private async runSpec(spec: T): Promise<ReturnType<U['callApi']>> {
    const input = this.buildInput(spec);
    const received = (await this.apiProvider.callApi(input.prompt, input.context)) as Awaited<
      ReturnType<U['callApi']>
    >;
    if (received.error) throw new Error(received.error);
    if (!received.output) throw new Error('result is empty');
    return received;
  }

  /**
   * Sets up jest tests to run an array of test cases.
   *
   * @param specs the test cases
   */
  private runSpecs(specs: T[]) {
    const clusterStateIdToSpec: Record<string, T[]> = {};
    specs.forEach((spec) => {
      if (clusterStateIdToSpec[spec.clusterStateId] === undefined)
        clusterStateIdToSpec[spec.clusterStateId] = [];
      clusterStateIdToSpec[spec.clusterStateId].push(spec);
    });
    describe.each(Object.keys(clusterStateIdToSpec))('Cluster state %s', (clusterStateId) => {
      beforeAll(() => {
        this.resetMetadata();
        return this.beforeAll(clusterStateId);
      });
      afterAll(() => {
        this.summarize();
        this.resetMetadata();
        return this.afterAll(clusterStateId);
      });
      beforeEach(() => this.beforeEach(clusterStateId));
      afterEach(() => this.afterEach(clusterStateId));
      it.each(clusterStateIdToSpec[clusterStateId])('Test-id $id', async (spec) => {
        console.info(`Running test: ${spec.id}`);
        const received = await this.runSpec(spec);
        await expect(received).toMatchRunnerExpectations(spec, this);
      });
    });
  }

  /**
   * Parses test cases from a file. Assumes each line is a JSON object and parses into {@link T}.
   *
   * @param filePath path that contains test specs
   * @returns an array of test specs
   */
  protected parseTestSpecs(filePath: string): T[] {
    const jsonLines = fs.readFileSync(filePath, 'utf8');
    return jsonLines
      .split('\n')
      .filter((line) => line)
      .map((line) => JSON.parse(line) as T);
  }

  /**
   * Sets up jest to run tests based on an array of test spec files.
   *
   * @param specFiles an array of test spec files
   */
  public run(specFiles: string[]) {
    describe.each(specFiles)('%s', (path) => {
      const specs = this.parseTestSpecs(path);
      void this.runSpecs(specs);
    });
  }

  /**
   * Cleanups metadata stored in memory for next spec file.
   */
  private resetMetadata() {
    this.resultsFilePath = undefined;
    this.persistedMetadata.length = 0;
  }

  /**
   * Creates a metadata object that stores the test id and results.
   *
   * @param spec the test case
   * @param received the returned response from api provider
   * @param result comparison result
   * @returns the metadata object
   */
  private buildMetadata(
    spec: T,
    received: Awaited<ReturnType<U['callApi']>>,
    result: TestResult,
  ): (typeof this.persistedMetadata)[number] & Record<string, unknown> {
    return {
      id: spec.id,
      score: result.score,
      pass: result.pass,
      output: received.output,
      error: received.error,
      extras: result.extras,
      executed_at: Date.now(),
    };
  }

  /**
   * Builds and writes metadata object to memory and to disk.
   */
  public async persistMetadata(...args: Parameters<typeof this.buildMetadata>) {
    const metadata = this.buildMetadata(...args);
    if (!this.resultsFilePath) {
      const resultDirPath = path.join(
        __dirname,
        '..',
        '..',
        'results',
        // runner class name or parent runner class name
        this.constructor.name || (Object.getPrototypeOf(this.constructor) as { name: string }).name,
      );
      await fsPromises.mkdir(resultDirPath, { recursive: true });
      const nextIndex =
        (await fsPromises.readdir(resultDirPath)).filter((file) => /results_\d+.jsonl/.test(file))
          .length + 1 || 0;
      this.resultsFilePath = path.join(resultDirPath, `results_${nextIndex}.jsonl`);
    }
    this.persistedMetadata.push(metadata);
    return fsPromises.appendFile(this.resultsFilePath, JSON.stringify(metadata) + '\n');
  }

  /**
   * Creates a summary based on test result metadata stored in memory.
   */
  protected summarize() {
    const total = this.persistedMetadata.length;
    const average =
      this.persistedMetadata.reduce((sum, metadata) => sum + metadata.score, 0) / total;
    const min = Math.min(...this.persistedMetadata.map((metadata) => metadata.score));
    const max = Math.max(...this.persistedMetadata.map((metadata) => metadata.score));
    const passRate = this.persistedMetadata.filter((metadata) => metadata.pass).length / total;
    const summary = `Summary: ${total} tests, average score: ${average.toFixed(
      2,
    )}, range: ${min.toFixed(2)} - ${max.toFixed(2)}. Pass rate: ${
      Number(passRate.toFixed(4)) * 100
    }%`;
    console.info(summary);
    return summary;
  }
}
