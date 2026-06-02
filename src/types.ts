export interface ToolCallLog {
  toolName: string;
  arguments: any;
  output: string;
  status: "success" | "error" | "running";
}

export interface LearnedLesson {
  id: string;
  category: string; // "VPS Конфигурация" | "Исправление Ошибок" | "Системная команда" | "Пользовательские факты"
  title: string;
  details: string;
  timestamp: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  reasoningContent?: string; // DeepAsk / DeepSeek reasoning thought process
  thinkingTime?: number;    // estimated thinking duration in seconds
  toolCalls?: ToolCallLog[]; // Logs of intermediate tool calls executed on backend
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  deepThink: boolean;  // toggle for reasoning model
  webSearch: boolean;  // toggle for search grounding
  createdAt: string;
  model?: string;      // "auto" | "deepseek-chat" | "deepseek-reasoning" | "gemini-3.5-flash"
}
