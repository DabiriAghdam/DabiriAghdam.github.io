/**
 * Private email relay for the chatbot activity digest.
 *
 * Add two Script Properties before deploying:
 *   DIGEST_TOKEN     a long random value shared with the worker
 *   DIGEST_TO_EMAIL  the only address this script is allowed to email
 */
function doPost(event) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const expectedToken = properties.getProperty("DIGEST_TOKEN");
    const recipient = properties.getProperty("DIGEST_TO_EMAIL");
    const payload = JSON.parse(event.postData.contents || "{}");

    if (!expectedToken || !recipient || payload.token !== expectedToken) {
      return jsonResponse({ ok: false, error: "unauthorized" });
    }
    if (payload.to !== recipient) {
      return jsonResponse({ ok: false, error: "recipient mismatch" });
    }
    if (!payload.subject || !payload.text) {
      return jsonResponse({ ok: false, error: "missing message fields" });
    }

    MailApp.sendEmail({
      to: recipient,
      subject: String(payload.subject).slice(0, 240),
      body: String(payload.text),
      htmlBody: payload.html ? String(payload.html) : undefined,
      name: "Amir website chat",
    });
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message || error).slice(0, 200) });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
