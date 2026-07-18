import { logger } from "./logger";

const WAFFGS_BASE = "https://waffgs.hrcwater.org/WAFFGS_MAPSERVER";
const BBOX_REGIONAL = "-14.8,1.5,17.7,32.3";

interface WaffgsLatestTime {
  year: string;
  month: string;
  day: string;
  hour: string;
  offset: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

let latestTimeCache: CacheEntry<WaffgsLatestTime | null> | null = null;

function getAuthHeader(): string {
  const user = process.env.WAFFGS_USER ?? "";
  const pass = process.env.WAFFGS_PASS ?? "";
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

export async function getWaffgsLatestTime(): Promise<WaffgsLatestTime | null> {
  const now = Date.now();
  if (latestTimeCache && now < latestTimeCache.expiresAt) {
    return latestTimeCache.value;
  }

  try {
    const params = new URLSearchParams({
      product: "ffgs_prod_est_asm_sacsma",
      dt: "06",
      bias: "NOMINAL",
      country: "REGIONAL",
      parent_dir: "/STORAGE/SYSTEMS/WAFFGS/OPERATIONAL/DATA/EXPORTS/REGIONAL/",
    });

    const res = await fetch(
      `${WAFFGS_BASE}/php_functions/get_latest_time_for_product.php`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000),
      }
    );

    const text = await res.text();
    const dataLine = text.split("\n").map((l) => l.trim()).find((l) => /^\d{4},/.test(l)) ?? "";
    const parts = dataLine.split(",");
    if (parts.length >= 4 && /^\d{4}$/.test(parts[0] ?? "")) {
      const [year, month, day, hour, offsetStr] = parts;
      const result: WaffgsLatestTime = {
        year: year ?? "",
        month: month?.padStart(2, "0") ?? "",
        day: day?.padStart(2, "0") ?? "",
        hour: (hour ?? "").padStart(2, "0"),
        offset: parseInt(offsetStr ?? "0", 10),
      };
      latestTimeCache = { value: result, expiresAt: now + 15 * 60 * 1000 };
      return result;
    }
  } catch (err) {
    logger.warn({ err }, "WAFFGS: impossible de récupérer la dernière date");
  }

  latestTimeCache = { value: null, expiresAt: now + 5 * 60 * 1000 };
  return null;
}

export interface WaffgsImageParams {
  product: "ASM" | "FFR";
  year: string;
  month: string;
  day: string;
  hour: string;
}

function resolveWaffgsProduct(product: "ASM" | "FFR"): {
  wmsProduct: string;
  layers: string;
  dt: string;
} {
  if (product === "ASM") {
    return {
      wmsProduct: "ffgs_prod_est_asm_sacsma",
      layers: "un_country_outlines,basin_outlines",
      dt: "06",
    };
  }
  return {
    wmsProduct: "ffgs_prod_fcst_ffr_outlook1",
    layers: "un_country_outlines,basin_outlines",
    dt: "06",
  };
}

export async function fetchWaffgsImage(
  params: WaffgsImageParams
): Promise<{ data: Buffer; contentType: string; hasData: boolean }> {
  const { wmsProduct, layers, dt } = resolveWaffgsProduct(params.product);

  const url = new URL(`${WAFFGS_BASE}/hrcms.php`);
  url.searchParams.set("SERVICE", "WMS");
  url.searchParams.set("VERSION", "1.1.1");
  url.searchParams.set("REQUEST", "GetMap");
  url.searchParams.set("LAYERS", layers);
  url.searchParams.set("product", wmsProduct);
  url.searchParams.set("dt", dt);
  url.searchParams.set("bias", "NOMINAL");
  url.searchParams.set("country", "REGIONAL");
  url.searchParams.set("year", params.year);
  url.searchParams.set("month", params.month);
  url.searchParams.set("day", params.day);
  url.searchParams.set("hour", params.hour);
  url.searchParams.set("use_xml_colorscale", "true");
  url.searchParams.set("colorscale_source", "custom");
  url.searchParams.set("WIDTH", "800");
  url.searchParams.set("HEIGHT", "600");
  url.searchParams.set("BBOX", BBOX_REGIONAL);
  url.searchParams.set("SRS", "EPSG:4326");
  url.searchParams.set("FORMAT", "image/png");

  const res = await fetch(url.toString(), {
    headers: { Authorization: getAuthHeader() },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`WAFFGS WMS error: ${res.status}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await res.arrayBuffer());

  const hasData =
    ct.startsWith("image/") &&
    !buffer.slice(0, 10).includes(60) &&
    buffer.length > 5000;

  return { data: buffer, contentType: ct.startsWith("image/") ? ct : "image/png", hasData };
}
