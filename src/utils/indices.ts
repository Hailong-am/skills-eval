/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'path';
import { MappingTypeMapping, SearchResponse } from '@opensearch-project/opensearch/api/types';
import { openSearchClient } from '../providers/clients/opensearch';
import { createPromisePool } from './promise_pool';

export class OpenSearchTestIndices {
  static indicesDir = path.join(__dirname, '../../data/indices');
  static promisePool = createPromisePool(10);

  public static async create(...groups: string[]) {
    const indexGroups = groups.length > 0 ? groups : await fs.readdir(this.indicesDir);
    return Promise.all(
      indexGroups.map(async (group) =>
        (await fs.readdir(path.join(this.indicesDir, group))).map((name) => {
          return this.promisePool.run(() => this.createIndex(group, name));
        }),
      ),
    );
  }

  public static async createIndices(indices: { group: string; name: string }[]) {
    return Promise.all(
      indices.map(async ({ group, name }) =>
        this.promisePool.run(() => this.createIndex(group, name)),
      ),
    );
  }

  public static async deleteAll() {
    const toChunk = <T>(arr: T[], size: number): T[][] =>
      Array.from({ length: Math.ceil(arr.length / size) }).map((_, i) =>
        arr.slice(size * i, size + size * i),
      );

    const indexGroups = await fs.readdir(this.indicesDir);
    const indices = (
      await Promise.all(indexGroups.map((group) => fs.readdir(path.join(this.indicesDir, group))))
    ).flat();

    const indexChunks = toChunk(indices, 20);
    await Promise.allSettled(
      indexChunks.map((indices) =>
        this.promisePool
          .run(() => openSearchClient.indices.delete({ index: indices, ignore_unavailable: true }))
          .catch((error) => {
            console.info('failed to delete ', String(error));
            throw error;
          }),
      ),
    );
    console.info('deleted all test indices');
  }

  private static async createIndex(group: string, name: string) {
    const indexDir = path.join(this.indicesDir, group, name);
    const mappingsPath = path.join(indexDir, 'mappings.json');
    const documentsPath = path.join(indexDir, 'documents.ndjson');
    try {
      await Promise.all(
        [mappingsPath, documentsPath].map((file) => fs.access(file, fs.constants.F_OK)),
      );
    } catch (error) {
      console.warn(`Skipping creating index '${name}': ${String(error)}`);
      return;
    }

    const mappings = JSON.parse(await fs.readFile(mappingsPath, 'utf-8')) as MappingTypeMapping;
    await openSearchClient.indices.create({ index: name, body: { mappings } });

    const ndjson = await fs.readFile(documentsPath, 'utf-8');
    const bulkBody = ndjson
      .split('\n')
      .filter((doc) => doc)
      .flatMap((doc) => [{ index: { _index: name } }, JSON.parse(doc) as object]);

    if (bulkBody.length > 0) await openSearchClient.bulk({ refresh: true, body: bulkBody });
    console.info(`created index ${name}`);
  }

  public static async dumpIndices(group: string, names: string[]) {
    return Promise.all(
      names.map(async (name) => {
        const indexDir = path.join(this.indicesDir, group, name);
        await fs.mkdir(indexDir, { recursive: true });
        const mappings = await openSearchClient.indices.get_mapping<{
          [name: string]: { mappings: MappingTypeMapping };
        }>({
          index: name,
        });
        const documents = await openSearchClient.search<SearchResponse>({
          index: name,
          size: 10000,
        });
        await fs.writeFile(
          path.join(indexDir, 'mappings.json'),
          JSON.stringify(mappings.body[name].mappings),
        );
        await fs.writeFile(
          path.join(indexDir, 'documents.ndjson'),
          documents.body.hits.hits.map((hit) => JSON.stringify(hit._source)).join('\n'),
        );
        console.info(`Dumped index ${name}`);
      }),
    );
  }

  public static async init() {
    const settings: Record<string, unknown> = {
      persistent: {
        'cluster.max_shards_per_node': '10000',
      },
    };
    await openSearchClient.cluster.putSettings({ body: settings });
  }
}
