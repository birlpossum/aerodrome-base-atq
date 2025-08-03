import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";
// --- constants & types ---
export const PAGE = 1000; // The Graph caps page size at 1 000
/**
 * Aerodrome subgraph on Base
 * Subgraph ID: GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM
 */
export function endpoint(apiKey?: string): string {
  if (!apiKey || apiKey === "dummy") {
    return "https://gateway.thegraph.com/api/[api-key]/subgraphs/id/GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM";
  }
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM`;
}

// --- types ---
interface Token {
  id: string;
  name: string;
  symbol: string;
}

interface Tick {
  tickIdx: string;
}

interface Pool {
  id: string;
  createdAtTimestamp: number;
  token0: Token;
  token1: Token;
  ticks: Tick[];
  feeTier: string; // basis points, as string
}

interface GraphQLData {
  pools: Pool[];
}

interface GraphQLResponse {
  data?: GraphQLData;
  errors?: { message: string }[];
}

// --- query ---
const PAIR_QUERY = `
  query GetPools($lastTimestamp: Int) {
    pools(
      first: 1000,
      orderBy: createdAtTimestamp,
      orderDirection: asc,
      where: { createdAtTimestamp_gt: $lastTimestamp }
    ) {
      id
      createdAtTimestamp
      feeTier
      token0 {
        symbol
        name
      }
      token1 {
        symbol
        name
      }
      ticks {
        tickIdx
      }
    }
  }
`;

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

function containsHtmlOrMarkdown(text: string): boolean {
  return /<[^>]+>/.test(text);
}

function isError(e: unknown): e is Error {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as Error).message === "string"
  );
}

function truncateString(text: string, maxLength: number) {
  if (text.length > maxLength) {
    return text.substring(0, maxLength - 3) + "...";
  }
  return text;
}

// --- utils ---
/** Decode 32-byte hex (with/without 0x) → printable ASCII, strip junk */
export function cleanSymbol(raw: string): string {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    raw = Buffer.from(hex, "hex")
      .toString("utf8")
      .replace(/\u0000/g, "");
  }
  const txt = raw.replace(/[^\u0002-\u007f]/g, "").trim(); // printable ASCII
  return txt.length >= 2 && txt.length <= 32 ? txt : "";
}
/**
 * Transform pools into ContractTag objects, applying policy and field validation.
 */
// Transform pools into ContractTag objects, applying policy and field validation.
function transformPoolsToTags(chainId: string, pools: Pool[]): ContractTag[] {
  // First, filter and log invalid entries
  const validPools: Pool[] = [];
  const rejectedNames: string[] = [];

  pools.forEach((pool) => {
    const token0Invalid =
      containsHtmlOrMarkdown(pool.token0.name) ||
      containsHtmlOrMarkdown(pool.token0.symbol);
    const token1Invalid =
      containsHtmlOrMarkdown(pool.token1.name) ||
      containsHtmlOrMarkdown(pool.token1.symbol);

    if (token0Invalid || token1Invalid) {
      if (token0Invalid) {
        rejectedNames.push(
          pool.token0.name + ", Symbol: " + pool.token0.symbol
        );
      }
      if (token1Invalid) {
        rejectedNames.push(
          pool.token1.name + ", Symbol: " + pool.token1.symbol
        );
      }
    } else {
      validPools.push(pool);
    }
  });

  // Log all rejected names
  if (rejectedNames.length > 0) {
    console.log(
      "Rejected token names due to HTML/Markdown content:",
      rejectedNames
    );
  }

  // Process valid pools into tags
  // Helper to infer tick spacing from tickIdxs
  function inferTickSpacing(ticks: Tick[]): number | undefined {
    if (!ticks || ticks.length < 2) return undefined;
    const idxs = ticks.map(t => Number(t.tickIdx)).sort((a, b) => a - b);
    let minSpacing = Infinity;
    for (let i = 1; i < idxs.length; i++) {
      const diff = Math.abs(idxs[i] - idxs[i - 1]);
      if (diff > 0 && diff < minSpacing) minSpacing = diff;
    }
    return isFinite(minSpacing) ? minSpacing : undefined;
  }

  // Helper to format feeTier as percent
  function formatFeeTier(feeTier: string): string {
    const bps = Number(feeTier);
    return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2) + ' %';
  }

  return validPools.map((pool) => {
    const maxSymbolsLength = 45;
    const symbolsText = `${pool.token0.symbol.trim()}/${pool.token1.symbol.trim()}`;
    const truncatedSymbolsText = truncateString(symbolsText, maxSymbolsLength);
    const tickSpacing = inferTickSpacing(pool.ticks);
    const prefix = tickSpacing ? `CL${tickSpacing}` : "CL?";
    const feePct = formatFeeTier(pool.feeTier);
    return {
      "Contract Address": `eip155:${chainId}:${pool.id}`,
      "Public Name Tag": `Aerodrome: ${prefix} ${truncatedSymbolsText} (${feePct})`,
      "Project Name": "Aerodrome",
      "UI/Website Link": "https://aerodrome.finance",
      "Public Note": `The Aerodrome liquidity pool contract for ${prefix} ${pool.token0.symbol}/${pool.token1.symbol} (${feePct}).`,

    };
  });
}


// --- main logic ---
interface GraphResponse<T> {
  data: T;
  errors?: unknown;
}

async function fetchPools(apiKey: string, lastTimestamp: number): Promise<Pool[]> {
  const resp = await fetch(endpoint(apiKey), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: PAIR_QUERY, variables: { lastTimestamp } }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP error: ${resp.status}`);
  }
  const json = (await resp.json()) as GraphQLResponse;
  if (json.errors) {
    json.errors.forEach((error) => {
      console.error(`GraphQL error: ${error.message}`);
    });
    throw new Error("GraphQL errors occurred: see logs for details.");
  }
  if (!json.data || !json.data.pools) {
    throw new Error("No pools data found.");
  }
  return json.data.pools;
}


class TagService implements ITagService {
  returnTags = async (
    chainId: string,
    apiKey: string
  ): Promise<ContractTag[]> => {
    if (Number(chainId) !== 8453)
      throw new Error(`Unsupported Chain ID: ${chainId}.`);
    if (!apiKey) throw new Error("API key is required");
    let lastTimestamp: number = 0;
    let allTags: ContractTag[] = [];
    let isMore = true;
    let counter = 0;
    const seenAddr = new Set<string>();
    while (isMore) {
      let pools: Pool[];
      try {
        pools = await fetchPools(apiKey, lastTimestamp);
        const tagsForPools = transformPoolsToTags(chainId, pools).filter(tag => {
          // Ensure unique contract address
          if (seenAddr.has(tag["Contract Address"])) return false;
          seenAddr.add(tag["Contract Address"]);
          return true;
        });
        allTags.push(...tagsForPools);
        counter++;
        console.log(`Retrieved first ${counter * 1000} entries...`);
        isMore = pools.length === 1000;
        if (isMore) {
          lastTimestamp = parseInt(
            pools[pools.length - 1].createdAtTimestamp.toString(),
            10
          );
        }
      } catch (error) {
        if (isError(error)) {
          console.error(`An error occurred: ${error.message}`);
          throw new Error(`Failed fetching data: ${error}`);
        } else {
          console.error("An unknown error occurred.");
          throw new Error("An unknown error occurred during fetch operation.");
        }
      }
    }
    return allTags;
  };
}

const tagService = new TagService();
export const returnTags = tagService.returnTags;
