// Narrow public test surface for host-managed native delivery regressions.
export { getActiveWebListener } from "./src/active-listener.js";
export { createAcceptedWhatsAppSendResult } from "./src/inbound/send-result.test-helper.js";
export { getWhatsAppRuntime, setWhatsAppRuntime } from "./src/runtime.js";
export { sendMessageWhatsApp } from "./src/send.js";
