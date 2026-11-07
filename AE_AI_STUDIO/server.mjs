
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================================================
// AYARLAR
// ==================================================

const PORT = 3000;
const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3:4b";

const MCP_ENTRY =
  "C:/Users/ACER/Documents/mcp/after-effects-mcp/packages/mcp-server/dist/index.js";

const MCP_CWD =
  "C:/Users/ACER/Documents/mcp/after-effects-mcp";

const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS = 20;

const BLOCKED_TOOLS = new Set([
  "log_issue",
  "list_known_issues"
]);

// Ollama bağlantısı için geniş zaman aşımı.
const ollamaAgent = new Agent({
  headersTimeout: 900000,
  bodyTimeout: 900000,
  connectTimeout: 30000
});

// Tasarım öncesinde sunucunun kendisinin çalıştıracağı araçlar.
const DESIGN_CONTEXT_TOOLS = [
  "get_project_summary",
  "list_comps",
  "get_house_style"
];

// ==================================================
// DURUM
// ==================================================

let mcpClient;
let mcpTools = [];
let mcpReady = false;
let busy = false;

// ==================================================
// MCP BAĞLANTISI
// ==================================================

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_ENTRY],
    cwd: MCP_CWD
  });

  mcpClient = new Client({
    name: "ae-ai-studio",
    version: "1.5.0"
  });

  await mcpClient.connect(transport);

  const result = await mcpClient.listTools();

  mcpTools = result.tools || [];
  mcpReady = true;

  console.log("\n==================================");
  console.log("AE AI STUDIO MCP BAĞLANTISI");
  console.log("==================================");
  console.log(`Toplam araç: ${mcpTools.length}`);

  console.log(
    mcpTools
      .filter(tool => !BLOCKED_TOOLS.has(tool.name))
      .map(tool => tool.name)
      .join(", ")
  );

  console.log("\nMCP bağlantısı hazır.");
  console.log("==================================\n");
}

// ==================================================
// GÖREV TÜRÜNÜ BELİRLE
// ==================================================

function classifyRequest(message) {
  const text = String(message || "").toLocaleLowerCase("tr-TR");

  const explicitReadOnly =
    /(hiçbir şeyi değiştirme|hiçbir şeyi oluşturma|sadece kontrol|sadece listele|yalnızca kontrol|yalnızca bilgi)/i;

  const designPattern =
    /(oluştur|tasarla|tasarım yap|hazırla|animasyon yap|animasyon oluştur|animasyonlandır|hareketlendir|çiz|inşa et|üret|ekle|geliştir|hud animasyonu|motion graphics|arayüz tasarla|grafik oluştur)/i;

  const readOnlyPattern =
    /(değiştirme|silme|bilgi ver|bilgilerini getir|özetini getir|özetle|kontrol et|listele|kaç tane|hangi kompozisyon|çözünürlüğünü|fps değerini|süresini|mevcut projeyi|aktif projeyi)/i;

  if (explicitReadOnly.test(text)) {
    return "read";
  }

  if (designPattern.test(text)) {
    return "design";
  }

  if (readOnlyPattern.test(text)) {
    return "read";
  }

  return "read";
}

// ==================================================
// GÖREVE GÖRE ARAÇ SEÇ
// ==================================================

// A quoted, explicit text-layer request is a deterministic, one-tool task.
// Do not expose the full HUD toolset to a small local model for this case.
function isSimpleTextLayerRequest(message) {
  const text = String(message || "");
  const asksForText = /(metin|yazı|text)/i.test(text);
  const asksToCreate = /(ekle|oluştur|yarat|create|add)/i.test(text);
  const hasQuotedValue = /["“”'‘’][^"“”'‘’]{1,120}["“”'‘’]/.test(text);
  return asksForText && asksToCreate && hasQuotedValue;
}

function selectToolsForMessage(message) {
  const taskType = classifyRequest(message);
  const simpleTextTask = isSimpleTextLayerRequest(message);

  const readOnlyTools = [
    "get_project_summary",
    "list_comps",
    "get_comp",
    "get_comp_tree",
    "list_layers",
    "get_layer_full",
    "get_selection",
    "find_layers",
    "list_effects",
    "get_keyframes",
    "get_expression",
    "list_available_effects",
    "get_house_style"
  ];

  // Keep the design toolset focused. Sending every write tool and its full
  // JSON schema can exceed small local models' context window; Ollama may then
  // expose only the last few tools (often screenshots and run_batch).
  // These are the core tools needed for a 2D HUD workflow.
  const designTools = [
    "create_comp",
    "set_active_comp",
    "create_shape_layer",
    "create_text_layer",
    "create_solid_layer",
    "set_transform",
    "add_keyframe",
    "set_interpolation",
    "set_temporal_ease",
    "add_effect",
    "set_effect_param",
    "set_text",
    "add_text_animator",
    "add_shape_content",
    "set_shape_property",
    "set_shape_path",
    "screenshot_frame",
    "screenshot_layer"
  ];

  const selectedNames = simpleTextTask
    ? ["create_text_layer"]
    : taskType === "design"
      ? designTools
      : readOnlyTools;

  const selectedTools = mcpTools.filter(tool =>
    selectedNames.includes(tool.name) &&
    !BLOCKED_TOOLS.has(tool.name)
  );

  console.log("\n==================================");
  console.log(`GÖREV TÜRÜ: ${taskType}`);
  console.log("MODELE GÖNDERİLEN ARAÇLAR:");
  console.log(
    selectedTools.map(tool => tool.name).join(", ")
  );
  const schemaSizes = selectedTools
    .map(tool => ({
      name: tool.name,
      chars: JSON.stringify(tool.inputSchema || {}).length
    }))
    .sort((a, b) => b.chars - a.chars);

  const schemaChars = schemaSizes.reduce(
    (total, tool) => total + tool.chars,
    0
  );

  console.log(`Modele gönderilen araç sayısı: ${selectedTools.length}`);
  console.log("ARAÇ ŞEMASI BOYUTLARI (büyükten küçüğe):");
  for (const tool of schemaSizes) {
    console.log(`  ${tool.name}: ${tool.chars} karakter`);
  }
  console.log(`Araç şemalarının toplam boyutu: ${schemaChars} karakter`);
  console.log("==================================\n");

  if (simpleTextTask) {
    console.log("HIZLI METİN KATMANI MODU: yalnızca create_text_layer aracı sunulacak.");
  }

  return {
    taskType,
    selectedTools,
    simpleTextTask
  };
}

// ==================================================
// TASARIM ÖNCESİ PROJE BİLGİSİNİ AL
// ==================================================

async function getDesignContext(activity, toolNames = DESIGN_CONTEXT_TOOLS) {
  console.log("\n==================================");
  console.log("TASARIM ÖNCESİ PROJE BİLGİSİ ALINIYOR");
  console.log("==================================");

  const contextParts = [];

  for (const name of toolNames) {
    const knownTool = mcpTools.find(
      tool => tool.name === name
    );

    if (!knownTool) {
      contextParts.push(
        `### ${name}\nBu araç MCP sunucusunda bulunamadı.`
      );

      continue;
    }

    const activityItem = {
      type: "tool",
      name,
      status: "running"
    };

    activity.push(activityItem);

    try {
      console.log(`Proje bilgisi alınıyor: ${name}`);

      const result = await mcpClient.callTool({
        name,
        arguments: {}
      });

      if (result?.isError) {
        throw new Error(toolResultToText(result));
      }

      const resultText = toolResultToText(result);

      activityItem.status = "completed";

      contextParts.push(
        `### ${name}\n${resultText}`
      );

      console.log(`${name}: başarılı`);

    } catch (error) {
      const errorText =
        error.message || String(error);

      activityItem.status = "error";
      activityItem.error = errorText;

      contextParts.push(
        `### ${name} - Bilgi alınamadı\n${errorText}`
      );

      console.error(
        `${name} hatası:`,
        errorText
      );
    }
  }

  console.log("Proje ön bilgisi tamamlandı.");
  console.log("==================================\n");

  return contextParts.join("\n\n");
}

// ==================================================
// OLLAMA ARAÇ ŞEMALARI
// ==================================================

function toOllamaTools(tools) {
  return tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description:
        tool.description ||
        `After Effects MCP tool: ${tool.name}`,
      parameters: tool.inputSchema || {
        type: "object",
        properties: {}
      }
    }
  }));
}

/**
 * Read Ollama's NDJSON chat stream and reconstruct the same message shape
 * that the non-streaming API returns. Qwen 3 supports streamed tool calls.
 */
async function readOllamaStream(response) {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Ollama yanıt akışı okunamadı: response body bulunamadı.");
  }

  const decoder = new TextDecoder();
  const assistantMessage = {
    role: "assistant",
    content: ""
  };

  let buffer = "";
  let finalChunk = null;
  let messageChunks = 0;

  const consumeLine = line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const chunk = JSON.parse(trimmed);

    if (chunk.error) {
      throw new Error(chunk.error);
    }

    if (chunk.message && typeof chunk.message === "object") {
      messageChunks++;

      if (chunk.message.role) {
        assistantMessage.role = chunk.message.role;
      }

      if (typeof chunk.message.content === "string") {
        assistantMessage.content += chunk.message.content;
      }

      // Ollama emits the tool-call array as a message chunk. Keep the complete
      // array; the final statistics chunk normally has no tool_calls field.
      if (
        Array.isArray(chunk.message.tool_calls) &&
        chunk.message.tool_calls.length > 0
      ) {
        assistantMessage.tool_calls = chunk.message.tool_calls;
      }
    }

    if (chunk.done === true) {
      finalChunk = chunk;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        consumeLine(line);
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      consumeLine(buffer);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!finalChunk && messageChunks === 0) {
    throw new Error("Ollama boş veya tamamlanmamış bir yanıt akışı döndürdü.");
  }

  return {
    ...(finalChunk || {}),
    message: assistantMessage
  };
}


// ==================================================
// MCP PARAMETRELERİNİ DÜZELT
// ==================================================

function normalizeToolArguments(name, args) {
  const normalized = { ...(args || {}) };

  if (
    name === "get_comp" &&
    normalized.compId === undefined &&
    normalized.id !== undefined
  ) {
    normalized.compId = normalized.id;
    delete normalized.id;
  }

  return normalized;
}

// ==================================================
// MCP SONUCUNU METNE ÇEVİR
// ==================================================

function toolResultToText(result) {
  if (result?.structuredContent) {
    return JSON.stringify(result.structuredContent);
  }

  return (result?.content || [])
    .map(item => {
      if (item.type === "text") {
        return item.text;
      }

      return JSON.stringify(item);
    })
    .join("\n") || JSON.stringify(result);
}

// ==================================================
// JSON ARAÇ ÇAĞRISINI YAKALA
// ==================================================

function extractJsonToolCall(content, availableTools) {
  if (!content || typeof content !== "string") {
    return null;
  }

  const cleaned = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates = [cleaned];

  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");

  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(
      cleaned.slice(firstObject, lastObject + 1)
    );
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);

      const name =
        parsed.name ||
        parsed.tool ||
        parsed.function?.name;

      const args =
        parsed.arguments ??
        parsed.parameters ??
        parsed.function?.arguments ??
        {};

      if (
        name &&
        availableTools.some(tool => tool.name === name)
      ) {
        return {
          name,
          arguments:
            typeof args === "string"
              ? JSON.parse(args)
              : args
        };
      }
    } catch {
      // Geçersiz JSON.
    }
  }

  return null;
}

// ==================================================
// MCP ARACI ÇALIŞTIR
// ==================================================

async function callMcpTool(name, args, availableTools) {
  const knownTool = availableTools.find(
    tool => tool.name === name
  );

  if (!knownTool) {
    throw new Error(
      `Bu görev için izin verilmeyen araç: ${name}`
    );
  }

  if (BLOCKED_TOOLS.has(name)) {
    throw new Error(`Bu araç devre dışı: ${name}`);
  }

  const normalizedArgs = normalizeToolArguments(
    name,
    args
  );

  console.log("\n----------------------------------");
  console.log(`ARAÇ ÇALIŞIYOR: ${name}`);
  console.log("GELEN PARAMETRELER:", args);
  console.log("DÜZELTİLMİŞ PARAMETRELER:", normalizedArgs);
  console.log("----------------------------------");

  const result = await mcpClient.callTool({
    name,
    arguments: normalizedArgs
  });

  if (result?.isError) {
    throw new Error(toolResultToText(result));
  }

  return toolResultToText(result);
}

// ==================================================
// SİSTEM TALİMATI
// ==================================================

const systemPrompt = `
Sen AE AI STUDIO adlı uygulamanın After Effects animasyon asistanısın.

Görevin kullanıcının isteklerini Adobe After Effects içinde
gerçek MCP araçlarını kullanarak gerçekleştirmektir.

GENEL KURALLAR:

1. Kullanıcının isteğini dikkatlice değerlendir.
2. Kullanıcı sadece bilgi istiyorsa projeyi değiştirme.
3. Tasarım isteniyorsa uygun MCP araçlarını kullan.
4. Var olmayan araç isimleri uydurma.
5. Gerçek araç parametre şemalarını kullan.
6. Araç sonuçlarını dikkatlice incele.
7. Başarılı araç çağrısını sebepsiz yere tekrarlama.
8. Aynı araç ve aynı parametreleri tekrar çağırma.
9. log_issue ve list_known_issues kullanma.
10. Kullanıcı istemeden kompozisyon veya katman silme.
11. Araç hata verirse aynı hatalı çağrıyı tekrarlama.
12. İşlemleri mantıklı sırayla gerçekleştir.
13. İşlem tamamlandığında Türkçe açıklama yap.
14. Gerçekleştirmediğin işlemi tamamlanmış gibi gösterme.
15. Gereksiz araç çağrısı yapma.

ÖNEMLİ:

- Projenin kayıtlı olup olmadığını tasarım şartı olarak kullanma.
- Kullanıcı tasarım istiyorsa kayıtlı proje zorunluluğu uydurma.
- Proje kaydedilmemiş olsa bile mevcut açık kompozisyonda çalışabilirsin.
- Kullanıcı mevcut kompozisyonu kullanmanı istiyorsa yeni kompozisyon oluşturma.
- Tasarım için gerekli proje bilgileri sana ayrıca verilebilir.
- Sana verilmiş proje bilgilerini tekrar isteme veya tekrar araçla sorgulama.

PARAMETRE BİLGİSİ:

get_comp aracı kompozisyon kimliğini compId
parametresiyle alır. id parametresi kullanma.

Doğru örnek:
get_comp({ "compId": 1 })

SHAPE CONTENT ŞEMASI — KESİN PARAMETRE KURALLARI:

add_shape_content aracında content alanı strict şemadır. Aşağıdaki alanlar dışında
alan gönderme. fillColor, fill, width, height, w, h, x ve y GEÇERSİZDİR.

Üst seviye:
- compId: number
- layerId: number
- content: aşağıdaki türlerden biri
- parentGroupPath: yalnızca mevcut bir grup içine ekleme yaparken kullanılır.
  Kök Contents alanına eklerken parentGroupPath alanını tamamen ATLA.
- zOrder: isteğe bağlı "back" veya "front".

Geçerli content türleri:
1. Dikdörtgen:
{"type":"rect","name":"Panel","size":[300,120],"position":[0,0],"roundness":12}
2. Daire/elips:
{"type":"ellipse","name":"Radar","size":[240,240],"position":[0,0]}
3. Yıldız/poligon:
{"type":"star","name":"Marker","points":6,"outerRadius":20,"innerRadius":10,"position":[0,0]}
4. Yol:
{"type":"path","name":"Outline","vertices":[[0,0],[100,0],[100,100],[0,100]],"closed":true}
5. Dolgu (geometriden AYRI bir çağrı):
{"type":"fill","color":"#00ffcc","opacity":100}
6. Kontur (geometriden AYRI bir çağrı):
{"type":"stroke","color":"#00ffcc","width":3,"opacity":100,"lineCap":"round","lineJoin":"round"}
7. Grup: {"type":"group","name":"Radar Group"}
8. Trim: {"type":"trim","start":0,"end":75,"offset":0}
9. Repeater: {"type":"repeater","copies":8,"offset":0}
10. Merge: {"type":"merge","mode":1}

ÖNEMLİ UYGULAMA:
- Rect ve ellipse için boyut "size":[genişlik,yükseklik], konum "position":[x,y] şeklindedir.
- Renk/çizgi rect veya ellipse içine yazılmaz. Önce geometriyi, sonra ayrı add_shape_content
  çağrısıyla type:"fill" veya type:"stroke" ekle.
- Renk alanının adı yalnızca "color" ve değeri "#00ffcc" gibi HEX olabilir.
- parentGroupPath kök seviyede boş dizi [] veya [""] OLAMAZ; kökte tamamen atla.
- Araç hata mesajı bilinmeyen alanı bildirirse o alanı yeniden adlandırıp tahmin etme.
  Bu bölümdeki şemaya dön ve yalnızca geçerli alanlarla yeni çağrı yap.
- Bir add_shape_content çağrısı başarısızsa aynı hatalı yapıyı tekrarlama.

TASARIM GÖREVLERİNDE ÇIKTI KURALI (ÇOK ÖNEMLİ):

- İç düşünce, analiz, plan, varsayım veya açıklama metni yazma.
- "Let's", "First", "Wait" gibi planlama metinleri üretme.
- Tasarım görevinde ilk yanıtın doğrudan gerçek MCP tool_calls olmalıdır.
- Bir turda yalnızca gerçekten gerekli olan 1-3 araç çağrısı yap; sonuçları aldıktan sonra devam et.
- Kompozisyon yoksa çözünürlük/FPS/süre uydurma. create_comp çağırmadan önce kullanıcıdan eksik zorunlu kompozisyon ayarını sor.
- Araç çağrısı üretemiyorsan uzun açıklama yazma; tek cümleyle eksik bilgiyi sor.
- Her şeklin parametrelerini ilgili aracın şemasına göre üret.

TASARIM İŞ AKIŞI:

Tasarım isteğinde:

1. Sana verilen mevcut proje bilgisini incele.
2. Kullanıcının hedef kompozisyonunu belirle.
3. Mevcut kompozisyon varsa onu kullan.
4. Kullanıcı açıkça istemedikçe yeni kompozisyon oluşturma.
5. Katmanları mantıklı sırayla oluştur.
6. Tasarımı görsel olarak tamamla.
7. İsteniyorsa animasyon keyframe'lerini ekle.
8. Araç sonuçlarını kontrol et.
9. Tamamlanmayan işlemleri tamamlanmış gibi anlatma.

HUD TASARIMI:

Profesyonel HUD tasarımı istendiğinde:

- Koyu bilim kurgu arka planı kullan.
- Dengeli neon renkler kullan.
- Dairesel radar halkaları oluştur.
- Teknik çizgiler ve koordinat göstergeleri oluştur.
- Bilgi panelleri ekle.
- Küçük veri göstergeleri ve ölçüm alanları oluştur.
- Katmanları anlamlı şekilde isimlendir.
- Tasarımı görsel açıdan dengeli oluştur.
- Animasyon için keyframe araçlarını kullan.
- Gerekirse efektler ve maskeler kullan.
- Gereksiz yere yeni kompozisyon oluşturma.
- Var olan kompozisyonun çözünürlüğünü ve FPS değerini koru.
- Sadece tek bir şekil oluşturup işi bitmiş sayma.
- Birbirini tamamlayan birden fazla görsel öğe oluştur.
- Tasarımın merkez, kenar ve bilgi alanlarını dengeli yerleştir.

ARAÇ KULLANIMI:

Bir işlem gerekiyorsa gerçek MCP araç çağrısı yap.

Araç çağrısı yapmadan işlem yaptığını iddia etme.

Araç sonucu başarılıysa sonraki mantıklı işleme geç.

Bir araç başarısız olursa hatayı incele ve farklı parametrelerle
düzeltmek mümkünse yeniden dene. Aynı hatalı çağrıyı tekrarlama.

İşlem tamamlanınca kısa ve anlaşılır Türkçe özet ver.
`;

// ==================================================
// OLLAMA SOHBET MOTORU
// ==================================================

async function chatWithOllama(userMessage, history) {
  if (!mcpReady) {
    throw new Error("MCP sunucusu henüz hazır değil.");
  }

  const {
    taskType,
    selectedTools,
    simpleTextTask
  } = selectToolsForMessage(userMessage);

  const activity = [];

  let designContext = "";

  if (taskType === "design") {
    const contextTools = simpleTextTask
      ? ["get_project_summary", "list_comps"]
      : DESIGN_CONTEXT_TOOLS;
    designContext = await getDesignContext(activity, contextTools);
  }

  const tools = toOllamaTools(selectedTools);

  const contextPrompt =
    taskType === "design"
      ? simpleTextTask
        ? `

AFTER EFFECTS PROJE BİLGİSİ:
${designContext}

Bu bilgi sunucu tarafından alındı; tekrar okuma aracı çağırma.
Aktif kompozisyonun compId değerini kullan.
`
        : `

AFTER EFFECTS MEVCUT PROJE BİLGİSİ:

Aşağıdaki bilgiler sunucu tarafından tasarım başlamadan
önce alınmıştır. Bu araçlar tekrar çağrılmamalıdır.

${designContext}

ÇOK ÖNEMLİ:
- get_project_summary çağırma.
- list_comps çağırma.
- get_house_style çağırma.
- Bu bilgiler zaten yukarıda verilmiştir.
- Doğrudan kullanıcının tasarım isteğini gerçekleştir.
- Mevcut kompozisyonu kullan.
`
      : "";

  const safeHistory = simpleTextTask
    ? []
    : Array.isArray(history)
      ? history
          .filter(item =>
            item &&
            ["user", "assistant"].includes(item.role) &&
            typeof item.content === "string"
          )
          .slice(-10)
      : [];

  const simpleTextSystemPrompt = `You operate Adobe After Effects through MCP tools.
For this request, call create_text_layer exactly once.
The tool schema is authoritative. It requires compId; text is the requested string.
It does NOT require layerId. Do not create a comp or any other layer.
Use the active composition id from the supplied project information.
If no active composition can be identified, ask one short question instead of inventing an id.
Do not write analysis or a plan. Return the tool call only.`;

  const messages = [
    {
      role: "system",
      content: (simpleTextTask ? simpleTextSystemPrompt : systemPrompt) + contextPrompt
    },
    ...safeHistory,
    {
      role: "user",
      content: userMessage
    }
  ];

  let totalToolCalls = 0;

  const executedCalls = new Set();

  for (
    let round = 0;
    round < MAX_TOOL_ROUNDS;
    round++
  ) {
    console.log(
      `Ollama turu: ${round + 1}/${MAX_TOOL_ROUNDS}`
    );

    console.log("Ollama yanıtı bekleniyor...");

    const response = await fetch(
      `${OLLAMA_URL}/api/chat`,
      {
        method: "POST",

        // Ollama ilk token ve akış yanıtları için geniş zaman aşımı.
        dispatcher: ollamaAgent,

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          model: MODEL,
          messages,
          tools,
          stream: true,
          think: false,

          // Modelin bellekte kalma süresi.
          keep_alive: "10m",

          options: {
            temperature: 0.1,
            num_ctx: 8192,
            num_predict: simpleTextTask ? 128 : 512
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `Ollama hatası (${response.status}): ${await response.text()}`
      );
    }

    console.log("Ollama HTTP yanıtı alındı; akış okunuyor.");
    const data = await readOllamaStream(response);
    const assistantMessage = data.message || {};

    if (Number.isFinite(data.prompt_eval_count) || Number.isFinite(data.eval_count)) {
      const promptSeconds = Number.isFinite(data.prompt_eval_duration)
        ? (data.prompt_eval_duration / 1e9).toFixed(1)
        : "?";
      const outputSeconds = Number.isFinite(data.eval_duration)
        ? (data.eval_duration / 1e9).toFixed(1)
        : "?";

      console.log(
        `Ollama ölçümü: giriş ${data.prompt_eval_count ?? "?"} token / ${promptSeconds} sn; ` +
        `çıktı ${data.eval_count ?? "?"} token / ${outputSeconds} sn.`
      );
    }

    console.log("Ollama akışı tamamlandı.");

    messages.push(assistantMessage);

    let calls = assistantMessage.tool_calls || [];

    if (!calls.length) {
      const fallback = extractJsonToolCall(
        assistantMessage.content,
        selectedTools
      );

      if (fallback) {
        calls = [{
          function: {
            name: fallback.name,
            arguments: fallback.arguments
          }
        }];
      }
    }

    if (!calls.length) {
      return {
        reply:
          assistantMessage.content ||
          "İşlem tamamlandı.",
        activity
      };
    }

    for (const call of calls) {
      const name = call.function?.name;

      const rawArgs =
        call.function?.arguments ?? {};

      let args;

      try {
        args =
          typeof rawArgs === "string"
            ? JSON.parse(rawArgs)
            : rawArgs;
      } catch {
        args = {};
      }

      if (!name) {
        continue;
      }

      if (
        !selectedTools.some(tool => tool.name === name)
      ) {
        console.warn(
          `İzin verilmeyen araç engellendi: ${name}`
        );

        return {
          reply:
            `Model izin verilmeyen bir araç çağırmaya çalıştı: ${name}. İşlem güvenlik nedeniyle durduruldu.`,
          activity
        };
      }

      if (totalToolCalls >= MAX_TOOL_CALLS) {
        return {
          reply:
            "Araç çağrısı güvenlik sınırına ulaştı. Tamamlanan işlemler korunmuştur.",
          activity
        };
      }

      const normalizedArgs = normalizeToolArguments(
        name,
        args
      );

      const callKey =
        name + ":" + JSON.stringify(normalizedArgs);

      if (executedCalls.has(callKey)) {
        console.warn(
          `Tekrarlanan araç çağrısı engellendi: ${name}`
        );

        return {
          reply:
            `Tekrarlanan ${name} çağrısını engelledim. İşlem döngüsünü önlemek için durdum. Önceki başarılı işlemler korunmuştur.`,
          activity
        };
      }

      executedCalls.add(callKey);
      totalToolCalls++;

      const activityItem = {
        type: "tool",
        name,
        status: "running"
      };

      activity.push(activityItem);

      try {
        const result = await callMcpTool(
          name,
          normalizedArgs,
          selectedTools
        );

        messages.push({
          role: "tool",
          content: result,
          tool_name: name
        });

        activityItem.status = "completed";

      } catch (error) {
        const errorText =
          error.message || String(error);

        console.error(
          `MCP araç hatası (${name}):`,
          errorText
        );

        messages.push({
          role: "tool",
          content: `Tool error: ${errorText}`,
          tool_name: name
        });

        activityItem.status = "error";
        activityItem.error = errorText;
      }
    }
  }

  return {
    reply:
      "Modelin araç çağrısı tur sınırına ulaştı. Tamamlanan işlemleri kontrol edebilirsin.",
    activity
  };
}

// ==================================================
// HTTP SUNUCUSU
// ==================================================

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // DURUM API

  if (
    req.url === "/api/status" &&
    req.method === "GET"
  ) {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      mcp: mcpReady,
      toolCount: mcpTools.length,
      model: MODEL,
      busy
    }));

    return;
  }

  // CHAT API

  if (
    req.url === "/api/chat" &&
    req.method === "POST"
  ) {
    if (busy) {
      res.writeHead(429, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        error: "Önceki istek hâlâ işleniyor."
      }));

      return;
    }

    busy = true;

    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");

        if (
          typeof payload.message !== "string" ||
          !payload.message.trim()
        ) {
          throw new Error("Mesaj boş olamaz.");
        }

        const result = await chatWithOllama(
          payload.message.trim(),
          Array.isArray(payload.history)
            ? payload.history
            : []
        );

        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.end(JSON.stringify(result));

      } catch (error) {
        console.error("Chat hatası:", error);

        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json"
          });

          res.end(JSON.stringify({
            error: error.message || String(error)
          }));
        }

      } finally {
        busy = false;
      }
    });

    return;
  }

  // WEB ARAYÜZÜ

  let requestedPath;

  try {
    requestedPath =
      req.url === "/"
        ? "/index.html"
        : decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  const publicDirectory =
    path.resolve(__dirname, "public");

  const safePath = path.resolve(
    publicDirectory,
    "." + requestedPath
  );

  if (
    safePath !== publicDirectory &&
    !safePath.startsWith(publicDirectory + path.sep)
  ) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(safePath, (error, content) => {
    if (error) {
      res.writeHead(404).end("Not found");
      return;
    }

    const ext = path.extname(safePath);

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type":
        types[ext] || "application/octet-stream"
    });

    res.end(content);
  });
});

// ==================================================
// BAŞLAT
// ==================================================

try {
  await connectMcp();
} catch (error) {
  console.error("MCP bağlantı hatası:", error);
}

server.listen(PORT, () => {
  console.log("\n==================================");
  console.log("AE AI STUDIO ÇALIŞIYOR");
  console.log("==================================");
  console.log(`Adres: http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Maksimum araç turu: ${MAX_TOOL_ROUNDS}`);
  console.log(`Maksimum araç çağrısı: ${MAX_TOOL_CALLS}`);
  console.log("Ollama başlık zaman aşımı: 900 saniye");
  console.log("Ollama bağlam uzunluğu: 8192");
  console.log("==================================\n");
});

// ==================================================
// GÜVENLİ KAPATMA
// ==================================================

process.on("SIGINT", async () => {
  console.log("\nAE AI STUDIO kapatılıyor...");

  await mcpClient?.close().catch(() => {});
  await ollamaAgent.close().catch(() => {});

  server.close(() => {
    process.exit(0);
  });
});
