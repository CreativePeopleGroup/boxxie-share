// Your connection server address (from Cloudflare after you deploy the server).
// The GitHub workflow fills this in automatically from the SERVER_URL repository variable.
window.BOXXIE_CONFIG = {
  serverUrl: "__SERVER_URL__",
};
if (window.BOXXIE_CONFIG.serverUrl.indexOf("__") === 0) window.BOXXIE_CONFIG.serverUrl = "";
