// ═══════════════════════════════════════════════════════════════
//  AGENDIO SaaS — functions/kiwify-webhook.js
//  Cloud Function que recebe eventos de pagamento da Kiwify
//  e atualiza automaticamente o status de assinatura no Firestore.
//
//  DEPLOY:
//    npm install -g firebase-tools
//    firebase init functions
//    firebase deploy --only functions:kiwifyWebhook
//
//  URL gerada (cole na Kiwify → Configurações → Webhooks):
//    https://us-central1-SEU_PROJETO.cloudfunctions.net/kiwifyWebhook
// ═══════════════════════════════════════════════════════════════

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const crypto    = require('crypto');

// Inicializa o Admin SDK (uma vez por instância)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

// ── SEGREDO DO WEBHOOK ───────────────────────────────────────────
// Configure no Firebase: firebase functions:config:set kiwify.secret="SEU_SEGREDO"
// O segredo é encontrado em Kiwify → Configurações → Webhooks → Chave secreta
const KIWIFY_SECRET = functions.config().kiwify?.secret || 'configure-me';

// ── MAPEAMENTO DE EVENTOS KIWIFY ─────────────────────────────────
// Referência: https://developers.kiwify.com.br/webhooks
const EVENT_ACTIONS = {
  'order_approved':    'activate',   // Compra aprovada (cartão, boleto, PIX)
  'order_refunded':    'cancel',     // Reembolso processado
  'subscription_active': 'activate', // Assinatura recorrente renovada
  'subscription_cancelled': 'cancel',// Assinatura cancelada pelo cliente
  'subscription_expired': 'expire',  // Assinatura expirada por falta de pagamento
};

// ── CLOUD FUNCTION PRINCIPAL ─────────────────────────────────────
exports.kiwifyWebhook = functions.https.onRequest(async (req, res) => {
  // Aceita apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── 1. VERIFICAÇÃO DE ASSINATURA ────────────────────────────
    // A Kiwify envia um header com a assinatura HMAC-SHA256 do body
    // Verificamos para garantir que a requisição veio da Kiwify
    const signature = req.headers['x-kiwify-signature'] || '';
    const body      = JSON.stringify(req.body);
    const expected  = crypto
      .createHmac('sha256', KIWIFY_SECRET)
      .update(body)
      .digest('hex');

    if (signature !== expected) {
      console.warn('[Webhook] Assinatura inválida — possível requisição não autorizada');
      await logGlobal('warning', 'Webhook com assinatura inválida', { signature: signature.slice(0,10) });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── 2. EXTRAÇÃO DOS DADOS ────────────────────────────────────
    const event = req.body;
    const {
      event: eventType,      // ex: "order_approved"
      data,                  // dados do pedido
    } = event;

    // Extrai o email do comprador (usado para identificar o business)
    // A Kiwify envia o email no campo customer.email
    const customerEmail = data?.customer?.email || data?.subscription?.customer?.email;
    const orderId       = data?.id || data?.subscription?.id || 'unknown';
    const amount        = data?.amount_total || data?.plan?.price || 0;

    console.log(`[Webhook] Evento: ${eventType}, Email: ${customerEmail}, Order: ${orderId}`);

    if (!customerEmail) {
      console.error('[Webhook] Email do cliente não encontrado no payload');
      // Retornamos 200 para a Kiwify não retentar — mas logamos o problema
      await logGlobal('error', 'Webhook sem email do cliente', { eventType, orderId });
      return res.status(200).json({ received: true, warning: 'No customer email' });
    }

    // ── 3. BUSCA DO NEGÓCIO POR EMAIL ────────────────────────────
    // O email da compra deve ser o mesmo do cadastro no Agendio
    const businessSnap = await db.collection('businesses')
      .where('owner_email', '==', customerEmail)
      .limit(1)
      .get();

    if (businessSnap.empty) {
      console.warn(`[Webhook] Nenhum negócio encontrado para ${customerEmail}`);
      await logGlobal('warning', 'Webhook: negócio não encontrado', { customerEmail, eventType });
      return res.status(200).json({ received: true, warning: 'Business not found' });
    }

    const businessRef  = businessSnap.docs[0].ref;
    const businessId   = businessSnap.docs[0].id;
    const businessData = businessSnap.docs[0].data();

    // ── 4. REGISTRA O EVENTO DE PAGAMENTO ────────────────────────
    await db.collection('payments_log').add({
      business_id:      businessId,
      business_name:    businessData.nome_negocio,
      customer_email:   customerEmail,
      event:            eventType,
      kiwify_order_id:  orderId,
      amount:           amount / 100, // Kiwify envia em centavos
      raw_payload:      data,         // Payload completo para auditoria
      timestamp:        admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── 5. EXECUTA A AÇÃO ────────────────────────────────────────
    const action = EVENT_ACTIONS[eventType];

    if (action === 'activate') {
      // Compra ou renovação aprovada → ativa por 31 dias
      const venc = new Date();
      venc.setDate(venc.getDate() + 31);

      await businessRef.update({
        status:           'ativo',
        plano:            'pioneiro',
        data_vencimento:  admin.firestore.Timestamp.fromDate(venc),
        last_payment_id:  orderId,
        updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
      });

      await logBusiness(businessId, 'info', 'Assinatura ativada via Kiwify', {
        eventType, orderId, amount: amount / 100
      });

      console.log(`[Webhook] ✅ Assinatura ativada para ${businessId} (${businessData.nome_negocio})`);

    } else if (action === 'cancel') {
      // Cancelamento ou reembolso
      await businessRef.update({
        status:    'cancelado',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await logBusiness(businessId, 'info', 'Assinatura cancelada via Kiwify', { eventType, orderId });
      console.log(`[Webhook] ❌ Assinatura cancelada para ${businessId}`);

    } else if (action === 'expire') {
      await businessRef.update({
        status:    'vencido',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await logBusiness(businessId, 'info', 'Assinatura expirada via Kiwify', { eventType, orderId });
      console.log(`[Webhook] ⏰ Assinatura expirada para ${businessId}`);

    } else {
      // Evento não mapeado — registra mas não faz nada
      console.log(`[Webhook] Evento não mapeado: ${eventType}`);
      await logBusiness(businessId, 'info', `Evento Kiwify não mapeado: ${eventType}`, { orderId });
    }

    // Responde 200 para a Kiwify saber que processou com sucesso
    return res.status(200).json({ received: true, action: action || 'none' });

  } catch (error) {
    console.error('[Webhook] Erro interno:', error);
    await logGlobal('error', 'Erro interno no webhook Kiwify', { error: error.message });
    // Retorna 500 para a Kiwify retentar
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── HELPERS DE LOG ───────────────────────────────────────────────
async function logBusiness(businessId, type, message, data = {}) {
  try {
    await db.collection('businesses').doc(businessId).collection('logs').add({
      type, message, data,
      source:    'kiwify-webhook',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[Logger] Falha ao salvar log do negócio:', e);
  }
}

async function logGlobal(type, message, data = {}) {
  try {
    await db.collection('global_logs').add({
      type, message, data,
      source:    'kiwify-webhook',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[Logger] Falha ao salvar log global:', e);
  }
}
