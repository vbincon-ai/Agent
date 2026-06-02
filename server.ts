import express from "express";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const execAsync = promisify(exec);

// Load environment variables
dotenv.config();

// Lazy Gemini client helper
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(customKey?: string): GoogleGenAI {
  if (customKey) {
    return new GoogleGenAI({
      apiKey: customKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  if (!geminiClient) {
    const key = process.env.GEMINI_API_KEY || "";
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClient;
}

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

// Ensure directories exist
const CONVERSATIONS_DIR = path.join(process.cwd(), "data", "conversations");
const LESSONS_FILE = path.join(process.cwd(), "data", "lessons.json");

const initDirectories = async () => {
  try {
    await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
    console.log(`Directories normalized: ${CONVERSATIONS_DIR}`);
    
    // Seed default lessons if missing
    try {
      await fs.access(LESSONS_FILE);
    } catch {
      const defaultLessons = [
        {
          id: "seed-env",
          category: "VPS Конфигурация",
          title: "Иерархия окружения VPS",
          details: "Суперагент работает внутри контейнера Linux Alpine Docker. Доступны команды git, npx, bash, npm. Идеально подходит для проектирования full-stack сервисов.",
          timestamp: new Date().toISOString()
        },
        {
          id: "seed-loop",
          category: "Исправление Ошибок",
          title: "Защита от зацикливания",
          details: "При отладке сложных скриптов агент должен использовать постепенный запуск и проверять логи. Не запускать бесконечные фоновые циклы без вывода в файл.",
          timestamp: new Date().toISOString()
        }
      ];
      await fs.writeFile(LESSONS_FILE, JSON.stringify(defaultLessons, null, 2), "utf-8");
      console.log("Memory database seeded with initial lessons.");
    }
  } catch (err) {
    console.error("Failed to initialize system folders:", err);
  }
};
initDirectories();

// Memory CRUD operations
async function get_lessons(): Promise<any[]> {
  try {
    const raw = await fs.readFile(LESSONS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function add_lesson_record(category: string, title: string, details: string): Promise<any> {
  const list = await get_lessons();
  const index = list.findIndex(l => l.title.trim().toLowerCase() === title.trim().toLowerCase());
  
  const newItem = {
    id: `lesson-${Date.now()}`,
    category,
    title,
    details,
    timestamp: new Date().toISOString()
  };

  if (index !== -1) {
    // Override lesson with new findings
    list[index] = { ...list[index], ...newItem, id: list[index].id };
  } else {
    list.push(newItem);
  }
  
  await fs.writeFile(LESSONS_FILE, JSON.stringify(list, null, 2), "utf-8");
  return newItem;
}

// Define Superagent TOOLS
const DEEPSEEK_TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Прочесть содержимое текстового файла на сервере. Принимает относительный или абсолютный путь.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Путь к целевому файлу для чтения"
          }
        },
        "required": ["path"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Записать данные (текст, код) в файл на сервере. Автоматически создает папки при необходимости.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Путь к сохраняемому файлу"
          },
          "content": {
            "type": "string",
            "description": "Текстовое содержимое файла"
          }
        },
        "required": ["path", "content"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "run_command",
      "description": "Выполнить терминальную команду (shell-команду) на сервере VPS. Возвращает stdout и stderr.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "Команда для выполнения в bash / sh"
          }
        },
        "required": ["command"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Поиск свежей, актуальной информации в интернете по любому запросу.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Текст поискового запроса"
          }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "scrape_url",
      "description": "Импортировать текстовое содержимое веб-страницы по предоставленному URL.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "Прямой URL-адрес для загрузки текста"
          }
        },
        "required": ["url"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "memorize_lesson",
      "description": "Запомнить новый изученный факт, исправленную системную ошибку или полезное знание о VPS сервере или предпочтениях пользователя во внутреннюю базу знаний. Позволяет агенту САМООБУЧАТЬСЯ.",
      "parameters": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string",
            "enum": ["VPS Конфигурация", "Исправление Ошибок", "Системная команда", "Пользовательские факты"],
            "description": "Классификация полученного опыта"
          },
          "title": {
            "type": "string",
            "description": "Краткое понятное название вынесенного урока"
          },
          "details": {
            "type": "string",
            "description": "Полное описание факта, решение ошибки, код или команды, которые нужно сохранить."
          }
        },
        "required": ["category", "title", "details"]
      }
    }
  }
];

// Tool Implementation Logic
async function read_file_tool(filePath: string): Promise<string> {
  try {
    const target = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const text = await fs.readFile(target, "utf-8");
    return `--- СОДЕРЖИМОЕ ФАЙЛА ${filePath} ---\n${text}`;
  } catch (err: any) {
    return `Ошибка чтения файла: ${err.message}`;
  }
}

async function write_file_tool(filePath: string, content: string): Promise<string> {
  try {
    const target = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    return `Файл "${filePath}" успешно создан/записан.`;
  } catch (err: any) {
    return `Ошибка записи файла: ${err.message}`;
  }
}

async function run_command_tool(command: string): Promise<string> {
  try {
    console.log(`Executing terminal command: "${command}"`);
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    let output = "";
    if (stdout && stdout.trim()) output += stdout;
    if (stderr && stderr.trim()) output += `\n[STDERR]:\n${stderr}`;
    return output.trim() || "[Команда завершена без текстового вывода]";
  } catch (err: any) {
    let output = `Ошибка выполнения (${err.code || "Status Error"}): ${err.message}`;
    if (err.stdout) output += `\n[STDOUT]:\n${err.stdout}`;
    if (err.stderr) output += `\n[STDERR]:\n${err.stderr}`;
    return output;
  }
}

async function web_search_tool(query: string): Promise<string> {
  try {
    console.log(`Searching DuckDuckGo for: "${query}"`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!resp.ok) {
      throw new Error(`Поисковик вернул статус ${resp.status}`);
    }
    
    const html = await resp.text();
    const results: { title: string; snippet: string; link: string }[] = [];
    
    const parts = html.split('class="result results_links');
    for (let i = 1; i < Math.min(parts.length, 6); i++) {
      const part = parts[i];
      
      const titleMatch = part.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "Без названия";
      
      const linkMatch = part.match(/href="([^"]*)"/);
      let link = linkMatch ? linkMatch[1] : "";
      if (link.startsWith("//")) link = "https:" + link;
      
      const snippetMatch = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
      
      if (snippet || title) {
        results.push({ title, snippet, link });
      }
    }
    
    if (results.length === 0) {
      return "Результаты поиска не найдены. Сформулируйте запрос иначе.";
    }
    
    return results.map((r, i) => `[${i + 1}] [${r.title}](${r.link})\n${r.snippet}`).join("\n\n");
  } catch (err: any) {
    console.error("Search failure:", err);
    return `Не удалось выполнить поиск в сети: ${err.message}`;
  }
}

async function scrape_url_tool(targetUrl: string): Promise<string> {
  try {
    console.log(`Scraping text content from: ${targetUrl}`);
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!response.ok) {
      return `Ошибка HTTP: ${response.status} ${response.statusText}`;
    }
    
    const html = await response.text();
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/?[^>]+(>|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
      
    return text.slice(0, 5000) || "[Пустая страница или не удалось извлечь читаемый текст]";
  } catch (err: any) {
    return `Ошибка парсинга страницы: ${err.message}`;
  }
}

/**
 * Unified Chat Endpoint that directs to DeepSeek or Gemini API with Superagent tool-calling loop
 */
app.post("/api/chat", async (req, res): Promise<any> => {
  try {
    const { messages, deepThink, webSearch, model: requestedModel } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Некорректный запрос: требуется массив сообщений 'messages'." });
    }

    const deepseekKey = req.body.deepseekApiKey || req.headers["x-deepseek-key"] || process.env.DEEPSEEK_API_KEY;
    const geminiKey = req.body.geminiApiKey || req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;

    const hasDeepSeek = deepseekKey && deepseekKey.trim() !== "" && !deepseekKey.includes("MY_DEEPSEEK_API_KEY");
    const hasGemini = geminiKey && geminiKey.trim() !== "" && !geminiKey.includes("MY_GEMINI_API_KEY");

    let provider: "DeepSeek" | "Gemini" = "DeepSeek";
    let activeModel = "";
    const isReasoning = !!deepThink;

    const modelSelection = requestedModel || "auto";

    if (modelSelection === "auto") {
      if (hasDeepSeek) {
        provider = "DeepSeek";
        activeModel = isReasoning ? "deepseek-reasoning" : "deepseek-chat";
      } else if (hasGemini) {
        provider = "Gemini";
        activeModel = "gemini-3.5-flash";
      } else {
        return res.status(400).json({
          error: "Ни один из ключей API (DEEPSEEK_API_KEY или GEMINI_API_KEY) не настроен. Пожалуйста, укажите хотя бы один из них в Secrets/Свойствах."
        });
      }
    } else if (modelSelection === "gemini-3.5-flash") {
      provider = "Gemini";
      activeModel = "gemini-3.5-flash";
      if (!hasGemini) {
        return res.status(400).json({
          error: "Выбранная модель Gemini недоступна, так как GEMINI_API_KEY не задан."
        });
      }
    } else {
      provider = "DeepSeek";
      activeModel = modelSelection === "deepseek-reasoning" ? "deepseek-reasoning" : "deepseek-chat";
      if (!hasDeepSeek) {
        return res.status(400).json({
          error: "Выбранная модель DeepSeek недоступна, так как DEEPSEEK_API_KEY не задан."
        });
      }
    }

    console.log(`Processing message. Provider: ${provider}, Model: ${activeModel}, Reasoning: ${isReasoning}`);

    let loopMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      name: m.name,
      tool_call_id: m.tool_call_id,
    })) as any[];

    // Inject Superagent core prompt
    const hasSystemInstruction = loopMessages.some(m => m.role === "system");
    let systemText = "";
    if (!hasSystemInstruction) {
      const lessons = await get_lessons();
      const lessonsBlock = lessons.length > 0
        ? `\n\nНиже представлены факты и уроки, которые ты сам успешно изучил и записал во внутреннюю память самообучения на этом сервере VPS:\n${lessons.map((l, idx) => `[Урок #${idx+1}] Тема: ${l.category} - ${l.title}\nДетали: ${l.details}`).join("\n\n")}`
        : "";

      systemText = isReasoning 
        ? "Ты — высокоточный искусственный интеллект Ин-Кон. Отвечай детально, логично и веди глубокие рассуждения."
        : `Ты — высокотехнологичный Суперагент Ин-Кон. У тебя есть встроенные инструменты автоматизации VPS сервера (чтение и запись файлов, выполнение shell-команд, веб-поиск, импорт сайтов и запись уроков). Используй их активно при первой необходимости для решения задач пользователя. Отвечай на русском языке. Если ты изучил новые факты об инфраструктуре, сервере VPS или предпочтениях пользователя, выменяй и сохрани этот урок через 'memorize_lesson'.${lessonsBlock}`;

      loopMessages.unshift({
        role: "system",
        content: systemText
      });
    } else {
      systemText = loopMessages.find(m => m.role === "system")?.content || "";
    }

    let finalContent = "";
    let reasoningContent = "";
    let totalDuration = 0;
    const toolCallsRecorded: any[] = [];
    let completionNeeded = true;
    let iteration = 0;
    const maxIterations = 5;

    while (completionNeeded && iteration < maxIterations) {
      iteration++;
      console.log(`Superagent Loop Iteration ${iteration}... Provider: ${provider}, Model: ${activeModel}`);

      const startTime = Date.now();
      let hasToolCalls = false;
      let toolCallsToExecute: any[] = [];

      if (provider === "DeepSeek") {
        const bodyPayload: any = {
          model: activeModel,
          messages: loopMessages,
          temperature: activeModel === "deepseek-reasoning" ? 1.0 : 0.6,
        };

        if (activeModel !== "deepseek-reasoning") {
          bodyPayload.tools = DEEPSEEK_TOOLS;
          bodyPayload.tool_choice = "auto";
        }

        const response = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${deepseekKey}`
          },
          body: JSON.stringify(bodyPayload)
        });

        if (!response.ok) {
          const rawErr = await response.text();
          console.error(`DeepSeek API server error (${response.status}):`, rawErr);
          throw new Error(`Ошибка сервера DeepSeek API (${response.status}): ${rawErr}`);
        }

        const data: any = await response.json();
        totalDuration += Math.round((Date.now() - startTime) / 1000);

        const choice = data?.choices?.[0]?.message;
        finalContent = choice?.content || "";
        if (choice?.reasoning_content) {
          reasoningContent = choice.reasoning_content;
        }

        hasToolCalls = choice?.tool_calls && choice.tool_calls.length > 0;
        if (hasToolCalls) {
          toolCallsToExecute = choice.tool_calls;
          loopMessages.push({
            role: "assistant",
            content: choice.content || null,
            tool_calls: choice.tool_calls
          } as any);
        }
      } else {
        // Gemini Provider
        const client = getGeminiClient(geminiKey);
        
        // Setup gemini compatible tools
        const geminiTools = [
          {
            functionDeclarations: DEEPSEEK_TOOLS.map(t => ({
              name: t.function.name,
              description: t.function.description,
              parameters: {
                type: "OBJECT",
                properties: t.function.parameters.properties,
                required: t.function.parameters.required
              }
            }))
          }
        ];

        // Format message tree to Gemini parts format
        const geminiContents: any[] = [];
        for (const msg of loopMessages) {
          if (msg.role === "system") continue;
          
          const parts: any[] = [];
          if (msg.content) {
            parts.push({ text: msg.content });
          }
          
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              parts.push({
                functionCall: {
                  name: tc.function.name,
                  args: typeof tc.function.arguments === "string" 
                    ? JSON.parse(tc.function.arguments) 
                    : tc.function.arguments
                }
              });
            }
          }
          
          if (msg.role === "tool") {
            parts.push({
              functionResponse: {
                name: msg.name,
                response: { result: msg.content }
              }
            });
          }

          geminiContents.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts
          });
        }

        const configPayload: any = {
          systemInstruction: systemText,
          temperature: 0.6,
        };

        // Standard gemini supports function calling, use it
        if (!isReasoning) {
          configPayload.tools = geminiTools;
        }

        const response = await client.models.generateContent({
          model: activeModel,
          contents: geminiContents,
          config: configPayload
        });

        totalDuration += Math.round((Date.now() - startTime) / 1000);
        finalContent = response.text || "";

        const gCalls = response.functionCalls;
        hasToolCalls = gCalls && gCalls.length > 0;

        if (hasToolCalls) {
          // Map to standard tool call format
          const mappedCalls = gCalls.map((fc: any, idx: number) => ({
            id: `call-${Date.now()}-${idx}`,
            type: "function",
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args)
            }
          }));

          toolCallsToExecute = mappedCalls;
          loopMessages.push({
            role: "assistant",
            content: finalContent || null,
            tool_calls: mappedCalls
          } as any);
        }
      }

      if (!hasToolCalls) {
        completionNeeded = false;
        break;
      }

      // We have tool calls to execute!
      console.log(`Executing ${toolCallsToExecute.length} tool calls...`);

      for (const tc of toolCallsToExecute) {
        const toolName = tc.function.name;
        let args: any = {};
        try {
          args = typeof tc.function.arguments === "string" 
            ? JSON.parse(tc.function.arguments) 
            : tc.function.arguments;
        } catch (e) {
          console.error("Arg parsing error:", tc.function.arguments);
        }

        let output = "";
        let status: "success" | "error" = "success";

        try {
          if (toolName === "read_file") {
            output = await read_file_tool(args.path);
          } else if (toolName === "write_file") {
            output = await write_file_tool(args.path, args.content);
          } else if (toolName === "run_command") {
            output = await run_command_tool(args.command);
          } else if (toolName === "web_search") {
            output = await web_search_tool(args.query);
          } else if (toolName === "scrape_url") {
            output = await scrape_url_tool(args.url);
          } else if (toolName === "memorize_lesson") {
            const newItem = await add_lesson_record(args.category, args.title, args.details);
            output = `Новый урок "${newItem.title}" успешно сохранен в базу знаний самообучения VPS. Номер записи: ${newItem.id}`;
          } else {
            output = `Инструмент ${toolName} не поддерживается.`;
            status = "error";
          }
        } catch (execErr: any) {
          output = `Ошибка исполнения инструмента: ${execErr.message}`;
          status = "error";
        }

        toolCallsRecorded.push({
          toolName,
          arguments: args,
          output,
          status
        });

        // Add tool response to loopMessages
        loopMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: toolName,
          content: output
        } as any);
      }
    }

    return res.json({
      role: "assistant",
      content: finalContent,
      reasoningContent: reasoningContent || undefined,
      thinkingTime: reasoningContent || toolCallsRecorded.length > 0 ? totalDuration : undefined,
      provider: `${provider} API`,
      modelUsed: activeModel,
      toolCalls: toolCallsRecorded.length > 0 ? toolCallsRecorded : undefined
    });

  } catch (error: any) {
    console.error("Superagent Controller Error:", error);
    res.status(500).json({
      error: error.message || "Ошибка при выполнении запроса суперагента.",
    });
  }
});

/**
 * REST API for Session persistence across VPS server
 */
app.get("/api/sessions", async (req, res) => {
  try {
    const files = await fs.readdir(CONVERSATIONS_DIR);
    const sessions = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const raw = await fs.readFile(path.join(CONVERSATIONS_DIR, file), "utf-8");
          sessions.push(JSON.parse(raw));
        } catch (e) {
          console.error(`Corrupt session file skipped: ${file}`);
        }
      }
    }
    // Sort chronologically (newest first)
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(sessions);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read sessions: " + err.message });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const session = req.body;
    if (!session || !session.id) {
      return res.status(400).json({ error: "Missing session body payload or session ID." });
    }
    const targetFile = path.join(CONVERSATIONS_DIR, `${session.id}.json`);
    await fs.writeFile(targetFile, JSON.stringify(session, null, 2), "utf-8");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to save session: " + err.message });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const targetFile = path.join(CONVERSATIONS_DIR, `${id}.json`);
    await fs.unlink(targetFile);
    res.json({ success: true });
  } catch (err: any) {
    // If file already deleted, ignore and succeed
    res.json({ success: true });
  }
});

/**
 * REST API for Lessons persistence (Agent self-learning experience DB)
 */
app.get("/api/lessons", async (req, res) => {
  try {
    const lessons = await get_lessons();
    res.json(lessons);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read lessons: " + err.message });
  }
});

app.delete("/api/lessons/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const list = await get_lessons();
    const filtered = list.filter(l => l.id !== id);
    await fs.writeFile(LESSONS_FILE, JSON.stringify(filtered, null, 2), "utf-8");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete lesson: " + err.message });
  }
});

// Setup Vite middleware in Development mode, otherwise serve build files in Production mode
const startServer = async () => {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
};

startServer().catch((err) => {
  console.error("Error starting server:", err);
});
