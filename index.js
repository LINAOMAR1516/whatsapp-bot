// ============================================================
//  CHATBOT WHATSAPP — DROGUERIE
//  Serveur principal Node.js + Express
// ============================================================

const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");
const csv     = require("csv-parser");
const multer  = require("multer");
const FormData = require("form-data");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ─── CONFIG ────────────────────────────────────────────────
const CONFIG = {
  VERIFY_TOKEN   : process.env.VERIFY_TOKEN    || "mon_token_secret_123",
  WA_TOKEN       : process.env.WA_TOKEN        || "VOTRE_TOKEN_META_ICI",
  PHONE_ID       : process.env.PHONE_ID        || "VOTRE_PHONE_NUMBER_ID",
  ADMIN_PHONE    : process.env.ADMIN_PHONE     || "212XXXXXXXXX",  // votre numéro sans +
  PORT           : process.env.PORT            || 3000,
  SHOP_NAME      : process.env.SHOP_NAME       || "Droguerie Al Amal",
  CURRENCY       : "MAD",
};

// ─── ÉTAT DES CONVERSATIONS ────────────────────────────────
// stocke le panier et l'étape de chaque client
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { step: "menu", cart: [], name: "" };
  }
  return sessions[phone];
}

// ─── CHARGEMENT DES PRODUITS DEPUIS CSV ───────────────────
let PRODUCTS = [];

function loadProducts() {
  PRODUCTS = [];
  const csvPath = path.join(__dirname, "data", "produits.csv");
  if (!fs.existsSync(csvPath)) {
    console.warn("⚠️  produits.csv introuvable, utilisation des données démo");
    PRODUCTS = DEMO_PRODUCTS;
    return;
  }
  fs.createReadStream(csvPath)
    .pipe(csv({ separator: ";" }))
    .on("data", (row) => {
      PRODUCTS.push({
        id      : row.id?.trim(),
        nom     : row.nom?.trim(),
        desc    : row.description?.trim(),
        prix    : parseFloat(row.prix?.replace(",", ".")) || 0,
        promo   : row.prix_promo ? parseFloat(row.prix_promo.replace(",", ".")) : null,
        stock   : row.stock?.trim().toLowerCase() === "oui",
        photo   : row.photo?.trim() || null,   // nom du fichier dans /uploads
        categorie: row.categorie?.trim() || "Général",
      });
    })
    .on("end", () => console.log(`✅ ${PRODUCTS.length} produits chargés`));
}

// Produits de démonstration si CSV absent
const DEMO_PRODUCTS = [
  { id:"1", nom:"Dettol Antiseptique 500ml", desc:"Désinfectant multi-usages", prix:28.50, promo:null, stock:true, photo:null, categorie:"Désinfectants" },
  { id:"2", nom:"Javel Lavande 1L",          desc:"Eau de javel parfumée",      prix:12.00, promo:null, stock:true, photo:null, categorie:"Désinfectants" },
  { id:"3", nom:"Savon Marseille 400g",       desc:"Savon naturel pur végétal",  prix:9.50,  promo:null, stock:true, photo:null, categorie:"Hygiène" },
  { id:"4", nom:"Produit Sol Citron 1L",      desc:"Nettoyant sol parfumé",      prix:18.00, promo:15.00,stock:true, photo:null, categorie:"Nettoyage" },
  { id:"5", nom:"Balai Brosse Professionnel", desc:"Fibres dures longue durée",  prix:35.00, promo:null, stock:true, photo:null, categorie:"Matériel" },
  { id:"6", nom:"Papier Hygiénique x12",      desc:"Pack 12 rouleaux extra doux",prix:42.00, promo:38.00,stock:true, photo:null, categorie:"Hygiène" },
];

loadProducts();

// Rechargement à chaud toutes les 5 minutes
setInterval(loadProducts, 5 * 60 * 1000);

// ─── ENVOI DE MESSAGES WHATSAPP ───────────────────────────

async function sendText(to, text) {
  return waRequest({ messaging_product:"whatsapp", to, type:"text",
    text:{ body: text, preview_url: false } });
}

async function sendList(to, header, body, footer, sections) {
  return waRequest({
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      header: { type:"text", text: header },
      body:   { text: body },
      footer: { text: footer },
      action: { button:"Voir les options", sections }
    }
  });
}

async function sendButtons(to, bodyText, buttons) {
  return waRequest({
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b, i) => ({
          type: "reply",
          reply: { id: b.id || String(i), title: b.title.slice(0, 20) }
        }))
      }
    }
  });
}

async function sendImage(to, imageUrl, caption) {
  return waRequest({
    messaging_product:"whatsapp", to, type:"image",
    image: { link: imageUrl, caption }
  });
}

async function waRequest(data) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_ID}/messages`,
      data,
      { headers: {
          Authorization: `Bearer ${CONFIG.WA_TOKEN}`,
          "Content-Type": "application/json"
      }}
    );
    return res.data;
  } catch (err) {
    console.error("❌ WA API error:", err.response?.data || err.message);
  }
}

// ─── LOGIQUE DU BOT ───────────────────────────────────────

async function handleMessage(phone, name, message) {
  const session = getSession(phone);
  if (name && !session.name) session.name = name;

  const msg   = message.trim().toLowerCase();
  const step  = session.step;

  console.log(`📨 [${phone}] step=${step} msg="${message}"`);

  // ── MENU PRINCIPAL ──────────────────────────────────────
  if (msg === "menu" || msg === "0" || step === "menu") {
    session.step = "menu";
    await sendMenu(phone, session.name);
    return;
  }

  // ── CHOIX DEPUIS LE MENU ─────────────────────────────────
  if (step === "menu" || step === "awaiting_choice") {
    if (msg === "1" || msg.includes("catalogue") || msg === "voir_catalogue") {
      session.step = "catalogue";
      await sendCatalogue(phone);
    } else if (msg === "2" || msg.includes("promo") || msg === "voir_promos") {
      await sendPromos(phone);
    } else if (msg === "3" || msg.includes("commande") || msg === "mon_panier") {
      await sendCart(phone, session);
    } else if (msg === "4" || msg.includes("livraison") || msg === "info_livraison") {
      await sendLivraison(phone);
    } else {
      session.step = "awaiting_choice";
      await sendMenu(phone, session.name);
    }
    return;
  }

  // ── CATALOGUE : sélection d'un produit ──────────────────
  if (step === "catalogue") {
    const prod = findProduct(message);
    if (prod) {
      session.step = "product_detail";
      session.currentProduct = prod;
      await sendProductDetail(phone, prod);
    } else if (msg === "retour" || msg === "menu") {
      session.step = "menu";
      await sendMenu(phone, session.name);
    } else {
      await sendText(phone, "Tapez le numéro du produit ou *menu* pour revenir.");
    }
    return;
  }

  // ── DÉTAIL PRODUIT : ajouter au panier ──────────────────
  if (step === "product_detail") {
    const prod = session.currentProduct;
    if (msg === "commander" || msg === "ajouter" || msg === "cmd_oui") {
      session.step = "ask_qty";
      await sendText(phone, `Combien de *${prod.nom}* souhaitez-vous commander ? (tapez un chiffre)`);
    } else if (msg === "retour" || msg === "catalogue") {
      session.step = "catalogue";
      await sendCatalogue(phone);
    } else if (msg === "menu") {
      session.step = "menu";
      await sendMenu(phone, session.name);
    } else {
      await sendButtons(phone,
        `Voulez-vous commander *${prod.nom}* ?\n💰 Prix : *${formatPrice(prod)}*`,
        [{ id:"cmd_oui", title:"🛒 Commander" }, { id:"catalogue", title:"⬅️ Retour" }]
      );
    }
    return;
  }

  // ── QUANTITÉ ─────────────────────────────────────────────
  if (step === "ask_qty") {
    const qty = parseInt(message);
    if (!isNaN(qty) && qty > 0 && qty <= 100) {
      const prod = session.currentProduct;
      const existing = session.cart.find(i => i.id === prod.id);
      if (existing) existing.qty += qty;
      else session.cart.push({ ...prod, qty });
      session.step = "after_add";
      const total = cartTotal(session.cart);
      await sendButtons(phone,
        `✅ *${qty}x ${prod.nom}* ajouté au panier !\n\n🛒 Panier : *${session.cart.length} article(s)* — Total : *${total} ${CONFIG.CURRENCY}*`,
        [{ id:"voir_catalogue", title:"➕ Ajouter autre" }, { id:"mon_panier", title:"🛒 Voir panier" }]
      );
    } else {
      await sendText(phone, "⚠️ Veuillez entrer un nombre valide entre 1 et 100.");
    }
    return;
  }

  // ── APRÈS AJOUT ───────────────────────────────────────────
  if (step === "after_add") {
    if (msg === "voir_catalogue" || msg.includes("ajouter")) {
      session.step = "catalogue";
      await sendCatalogue(phone);
    } else if (msg === "mon_panier" || msg.includes("panier")) {
      await sendCart(phone, session);
    } else {
      session.step = "menu";
      await sendMenu(phone, session.name);
    }
    return;
  }

  // ── PANIER : confirmation ─────────────────────────────────
  if (step === "confirm_order") {
    if (msg === "confirmer" || msg === "oui" || msg === "confirm_yes") {
      await finalizeOrder(phone, session);
    } else if (msg === "modifier" || msg === "non" || msg === "confirm_no") {
      session.step = "catalogue";
      await sendText(phone, "D'accord ! Reprenons le catalogue 📦");
      await sendCatalogue(phone);
    } else if (msg === "vider" || msg === "annuler_panier") {
      session.cart = [];
      session.step = "menu";
      await sendText(phone, "🗑️ Panier vidé. Tapez *menu* pour recommencer.");
    } else {
      await sendCart(phone, session);
    }
    return;
  }

  // ── DEMANDE D'ADRESSE ─────────────────────────────────────
  if (step === "ask_address") {
    session.address = message;
    session.step = "ask_name";
    await sendText(phone, `👤 Quel est votre nom complet pour la livraison ?`);
    return;
  }

  if (step === "ask_name") {
    session.clientName = message;
    await placeOrder(phone, session);
    return;
  }

  // ── FALLBACK ──────────────────────────────────────────────
  session.step = "menu";
  await sendMenu(phone, session.name);
}

// ─── MESSAGES ENVOYÉS ─────────────────────────────────────

async function sendMenu(phone, name) {
  const prenom = name ? name.split(" ")[0] : "cher client";
  await sendList(phone,
    `🏪 ${CONFIG.SHOP_NAME}`,
    `Salam ${prenom} ! 👋\nBienvenue, comment puis-je vous aider ?`,
    "Répondez avec le numéro ou tapez votre choix",
    [{
      title: "Menu principal",
      rows: [
        { id:"voir_catalogue",  title:"📦 Catalogue produits", description:"Voir tous nos produits" },
        { id:"voir_promos",     title:"🏷️ Promotions",         description:"Nos offres spéciales" },
        { id:"mon_panier",      title:"🛒 Mon panier",          description:"Voir ma commande en cours" },
        { id:"info_livraison",  title:"🚚 Livraison",           description:"Tarifs et délais" },
      ]
    }]
  );
}

async function sendCatalogue(phone) {
  const dispo = PRODUCTS.filter(p => p.stock);
  if (dispo.length === 0) {
    await sendText(phone, "😔 Aucun produit disponible pour l'instant. Revenez bientôt !");
    return;
  }

  // Grouper par catégorie
  const categories = {};
  dispo.forEach(p => {
    if (!categories[p.categorie]) categories[p.categorie] = [];
    categories[p.categorie].push(p);
  });

  const sections = Object.entries(categories).map(([cat, prods]) => ({
    title: cat,
    rows: prods.slice(0, 10).map(p => ({
      id: `prod_${p.id}`,
      title: p.nom.slice(0, 24),
      description: `${formatPrice(p)} ${CONFIG.CURRENCY}${p.promo ? " 🔥 PROMO" : ""}`
    }))
  }));

  await sendList(phone,
    "📦 Nos produits",
    "Sélectionnez un produit pour voir les détails et commander :",
    "Stock disponible · Livraison rapide",
    sections
  );
}

async function sendProductDetail(phone, prod) {
  const prix = `${formatPrice(prod)} ${CONFIG.CURRENCY}`;
  let caption = `*${prod.nom}*\n\n📝 ${prod.desc}\n💰 Prix : *${prix}*`;
  if (prod.promo) caption += `\n~~Ancien prix : ${prod.prix.toFixed(2)} MAD~~`;
  caption += `\n\nTapez *commander* pour ajouter au panier ou *retour* pour continuer.`;

  if (prod.photo) {
    const imageUrl = `${process.env.BASE_URL || "http://localhost:3000"}/uploads/${prod.photo}`;
    await sendImage(phone, imageUrl, caption);
  } else {
    await sendButtons(phone, caption,
      [{ id:"cmd_oui", title:"🛒 Commander" }, { id:"catalogue", title:"⬅️ Retour" }]
    );
  }
}

async function sendPromos(phone) {
  const promos = PRODUCTS.filter(p => p.promo && p.stock);
  if (promos.length === 0) {
    await sendText(phone, "Pas de promotion en ce moment. Revenez bientôt ! 😊\n\nTapez *menu* pour continuer.");
    return;
  }
  let txt = `🏷️ *NOS PROMOTIONS DU MOMENT*\n${"─".repeat(25)}\n\n`;
  promos.forEach(p => {
    const eco = (p.prix - p.promo).toFixed(2);
    txt += `✅ *${p.nom}*\n   ~~${p.prix.toFixed(2)} MAD~~ → *${p.promo.toFixed(2)} MAD* (-${eco} MAD)\n\n`;
  });
  txt += "Tapez *catalogue* pour commander.";
  await sendText(phone, txt);
}

async function sendCart(phone, session) {
  if (session.cart.length === 0) {
    await sendButtons(phone,
      "🛒 Votre panier est vide.\nCommencez par explorer notre catalogue !",
      [{ id:"voir_catalogue", title:"📦 Voir catalogue" }, { id:"menu", title:"🏠 Menu" }]
    );
    return;
  }
  let txt = `🛒 *VOTRE PANIER*\n${"─".repeat(25)}\n\n`;
  session.cart.forEach((item, i) => {
    const px = item.promo || item.prix;
    txt += `${i+1}. *${item.nom}*\n   ${item.qty} × ${px.toFixed(2)} MAD = *${(item.qty * px).toFixed(2)} MAD*\n\n`;
  });
  txt += `${"─".repeat(25)}\n💰 *TOTAL : ${cartTotal(session.cart)} ${CONFIG.CURRENCY}*`;

  session.step = "confirm_order";
  await sendButtons(phone, txt,
    [
      { id:"confirm_yes",    title:"✅ Confirmer" },
      { id:"voir_catalogue", title:"➕ Ajouter" },
      { id:"annuler_panier", title:"🗑️ Vider panier" },
    ]
  );
}

async function sendLivraison(phone) {
  await sendText(phone,
    `🚚 *INFORMATIONS LIVRAISON*\n${"─".repeat(25)}\n\n` +
    `📍 Zone couverte : Rabat & Salé\n` +
    `⏱️ Délai : 1 à 3 heures\n` +
    `💵 Frais de livraison :\n   • Commande < 100 MAD → 10 MAD\n   • Commande ≥ 100 MAD → *GRATUITE* 🎁\n\n` +
    `💳 Paiement à la livraison (cash)\n\n` +
    `Tapez *menu* pour revenir.`
  );
}

async function finalizeOrder(phone, session) {
  session.step = "ask_address";
  await sendText(phone, `📍 Parfait ! Veuillez entrer votre *adresse de livraison* complète :`);
}

async function placeOrder(phone, session) {
  const orderId = "ORD-" + Date.now().toString().slice(-6);
  const total   = cartTotal(session.cart);
  const name    = session.clientName || session.name || "Client";
  const address = session.address || "Non précisée";

  // ── Message de confirmation au CLIENT ──────────────────
  let confirmClient =
    `✅ *COMMANDE CONFIRMÉE !*\n${"─".repeat(25)}\n\n` +
    `🆔 Référence : *${orderId}*\n` +
    `👤 Nom : ${name}\n` +
    `📍 Adresse : ${address}\n\n` +
    `🛒 *Détail :*\n`;
  session.cart.forEach(item => {
    const px = item.promo || item.prix;
    confirmClient += `  • ${item.qty}x ${item.nom} → ${(item.qty * px).toFixed(2)} MAD\n`;
  });
  confirmClient +=
    `\n💰 *Total : ${total} ${CONFIG.CURRENCY}*\n` +
    `💵 Paiement à la livraison\n` +
    `⏱️ Livraison estimée : 1–3h\n\n` +
    `Merci pour votre confiance ! 🙏\n_${CONFIG.SHOP_NAME}_`;

  await sendText(phone, confirmClient);

  // ── Notification à l'ADMIN ─────────────────────────────
  let notifAdmin =
    `🔔 *NOUVELLE COMMANDE* — ${orderId}\n${"─".repeat(25)}\n\n` +
    `👤 Client : ${name}\n📞 Tél : +${phone}\n📍 Adresse : ${address}\n\n` +
    `🛒 *Articles :*\n`;
  session.cart.forEach(item => {
    const px = item.promo || item.prix;
    notifAdmin += `  • ${item.qty}x ${item.nom} = ${(item.qty * px).toFixed(2)} MAD\n`;
  });
  notifAdmin += `\n💰 *TOTAL : ${total} ${CONFIG.CURRENCY}*`;

  await sendText(CONFIG.ADMIN_PHONE, notifAdmin);

  // ── Sauvegarde locale ──────────────────────────────────
  saveOrder({ orderId, phone, name, address, cart: session.cart, total, date: new Date().toISOString() });

  // ── Réinitialiser la session ───────────────────────────
  session.cart  = [];
  session.step  = "menu";
  session.address     = null;
  session.clientName  = null;
}

// ─── UTILITAIRES ──────────────────────────────────────────

function findProduct(input) {
  const id  = input.replace("prod_", "").trim();
  const txt = input.toLowerCase();
  return PRODUCTS.find(p =>
    p.id === id ||
    p.nom.toLowerCase().includes(txt) ||
    `prod_${p.id}` === input
  );
}

function formatPrice(prod) {
  return prod.promo
    ? `~~${prod.prix.toFixed(2)}~~ *${prod.promo.toFixed(2)}*`
    : prod.prix.toFixed(2);
}

function cartTotal(cart) {
  return cart.reduce((s, i) => s + i.qty * (i.promo || i.prix), 0).toFixed(2);
}

function saveOrder(order) {
  const file = path.join(__dirname, "data", "commandes.json");
  let orders = [];
  if (fs.existsSync(file)) {
    try { orders = JSON.parse(fs.readFileSync(file)); } catch {}
  }
  orders.push(order);
  fs.writeFileSync(file, JSON.stringify(orders, null, 2));
  console.log(`💾 Commande ${order.orderId} sauvegardée`);
}

// ─── WEBHOOK ROUTES ───────────────────────────────────────

// Vérification du webhook Meta
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié !");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Réception des messages
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // répondre immédiatement à Meta

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];
    if (!message) return;

    const phone = message.from;
    const name  = changes?.contacts?.[0]?.profile?.name || "";

    let text = "";
    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "interactive") {
      const inter = message.interactive;
      text = inter.list_reply?.id || inter.button_reply?.id || "";
    } else {
      await sendText(phone, "Je ne comprends que les messages texte pour l'instant. Tapez *menu* pour commencer.");
      return;
    }

    await handleMessage(phone, name, text);
  } catch (err) {
    console.error("❌ Erreur webhook:", err);
  }
});

// ─── ROUTES ADMIN (tableau de bord simple) ───────────────

app.get("/admin/commandes", (req, res) => {
  const file = path.join(__dirname, "data", "commandes.json");
  if (!fs.existsSync(file)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(file)));
});

app.get("/admin/produits", (req, res) => res.json(PRODUCTS));

app.post("/admin/reload", (req, res) => {
  loadProducts();
  res.json({ message: "Produits rechargés", count: PRODUCTS.length });
});

// Upload photo produit
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename:    (req, file, cb) => cb(null, `prod_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/admin/upload", upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" });
  res.json({ filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

app.get("/", (req, res) => res.send(`
  <h2>🏪 ${CONFIG.SHOP_NAME} — Bot WhatsApp actif</h2>
  <p>Webhook : <code>/webhook</code></p>
  <p><a href="/admin/commandes">📋 Voir les commandes</a></p>
  <p><a href="/admin/produits">📦 Voir les produits</a></p>
`));

// ─── DÉMARRAGE ────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 Bot démarré sur le port ${CONFIG.PORT}`);
  console.log(`📡 Webhook URL : https://VOTRE_DOMAINE/webhook`);
  console.log(`🏪 Boutique : ${CONFIG.SHOP_NAME}\n`);
});
