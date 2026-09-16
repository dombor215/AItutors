// ============================================================
// PAGE APPEARANCE
// ============================================================

const tabTitle = "AI Tutor";
const headerTitle = "Impacts of Science: Mechanics and Society";
const copyrightText = "© 2026 Dominik Borovský & Jozef Hanč v2.4, powered by OpenAI GPT-5.3";
// const  headerImageUrl = "https://i.postimg.cc/YSFf8VV7/logo-PF-UPJS.png";
const  headerImageUrl = "https://i.postimg.cc/tTpnTCJM/odf-ufv-logo.png";


// ============================================================
// AI CONNECTION
// ============================================================

// AI provider or your existing Cloudflare Worker endpoint.
const API_URL = "https://ai-wrapper.dominik-borovsky123.workers.dev/v1/chat/completions";

const MODEL_NAME = "srobarka-chat";

// Without PocketBase:
// This value is combined with the key entered by the pupil.
//
// With PocketBase:
// This contains the complete API key/token required by your
// existing AI endpoint. The "Insert key" button is hidden.
//
// Any value in this file is visible to someone inspecting the page.
// Do not put PocketBase administrator credentials here.
const API_FIRST_PART = "odf*ufv*sage";


// ============================================================
// POCKETBASE AND CONVERSATION STORAGE
// ============================================================

// Leave empty to use standalone mode with manual JSON saving.
//
// To enable pupil login and database storage, enter your
// PocketBase address, without a trailing slash.
const POCKETBASE_URL = "https://mauve-vole.pikapod.net";

// Proposed collection names for the website implementation.
const POCKETBASE_USERS_COLLECTION = "users";
const POCKETBASE_CONVERSATIONS_COLLECTION = "conversations";

// Stable identifier for this tutor/activity.
//
// Stored as the conversation's "origin" field.
// Each pupil's conversations are separated by this identifier.
//
// Use a different value for another activity.
// Keep this unchanged when you only change the page title.
const CHAT_ORIGIN = "mechanics-and-society";


// ============================================================
// FEATURE VISIBILITY
// ============================================================

// These settings control the normal website interface.
// They are not server-enforced permissions.

// Show the button for starting a new conversation.
const allowNewChat = true;

// Show message-delete controls.
//
// Deletion is soft deletion:
// - keep the message in the stored JSON;
// - add deleted: true and deletedAt;
// - hide it from the conversation;
// - exclude it from subsequent AI requests;
// - save the updated conversation immediately.
const allowDelete = true;

// Show the JSON conversation-import button.
//
// In PocketBase mode, importing creates a new conversation
// and saves it immediately rather than replacing the current one.
const allowImport = true;

// Show the JSON conversation-download button.
const allowExport = true;

// Show file/image attachment controls.
const allowAttachments = true;

// Show the drawing tool independently of file uploads.
const allowDrawing = true;

// Show the older-conversation browser.
//
// Only applicable when PocketBase is configured.
// Hiding it does not disable restoring the latest conversation.
const showConversationBrowser = true;


// ============================================================
// INPUT BEHAVIOR
// ============================================================

// Retains your existing pasted-text alteration setting.
const copyPasteProtection = false;


// ============================================================
// WELCOME MESSAGE
// ============================================================

// Markdown is supported.
//
// The message adapts to PocketBase mode and the visible controls,
// so it does not tell pupils to use buttons that are hidden.

const FIRST_MESSAGE = `
Welcome to the AI tutor Maya for physics. Her goal is to guide you through a discussion about the impacts of science on society.

Before starting this discussion, remember to:

${POCKETBASE_URL.trim()
  ? "* **Log in** using the username and password provided by your teacher."
  : "* **Enter the key** that you received from your teacher using the 🔑 button."}

* Choose **one topic** that interests you most from the options Maya provides.
* You can start the discussion by typing *"Hi!"* or *"Hello!"*.

${allowExport
  ? `### Saving a copy

* **Save the conversation** using 💾 to download a JSON file.
* If your teacher asks you to submit it, **rename the file** using your name and surname, for example *lincoln_abraham.json*.
`
  : ""}

${allowImport
  ? `### Importing a conversation

Use 📂 to upload a previously downloaded conversation JSON file.
${POCKETBASE_URL.trim()
  ? "The imported history will be saved as a new conversation."
  : ""}
`
  : ""}

${POCKETBASE_URL.trim()
  ? `### Automatic saving

Your conversation is saved to your account after each completed AI response. Wait for the response and save confirmation before closing the page.

When you return and log in, your latest conversation for this activity will be restored.

${showConversationBrowser
  ? "You can also use the conversation browser to open an older conversation for this activity."
  : ""}
`
  : `**WARNING:** This page does not save your conversation to a database. Closing or reloading the page may lose your conversation.${
      allowExport
        ? " Download a copy before leaving."
        : " The conversation-download option is disabled for this activity."
    }`}
`.trim();


// ============================================================
// SYSTEM PROMPT
// ============================================================

const CONTENT_USER = `
## Interactive quizzes

Introduce yourself as Maya, a general AI tutor for physics. Offer students help with anything, ask them for the desired topic or theme. At the begining of the conversation mention that you are able to also provide quizzes if they want to try.

If you are about to include some formulas, use LaTeX, such as $K_E = \frac{1}{2}mv^2$

When a short knowledge check would genuinely help the student,
return it in a fenced code block that starts with \`\`\`quiz and
contains valid JSON with this shape:

\`\`\`quiz
{"title": "Quiz title", "questions": [{"question": "...", "options": ["..."], "answer": 0, "explanation": "..."}]}
\`\`\`

Rules for quiz blocks:
- Use 1-10 questions, each with 2-6 options.
- "answer" is the zero-based index of the correct option.
- Include a short optional "explanation" shown after checking.
- Keep the quiz relevant to the current discussion topic.
- Never generate <script>, <iframe>, <form>, or full HTML documents;
  quizzes must be quiz JSON blocks only.
Use quizzes sparingly: when the student asks to be tested, when a
topic is completed, or when a quick check would consolidate learning.
`;