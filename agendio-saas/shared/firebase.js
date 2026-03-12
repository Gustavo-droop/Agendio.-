// ═══════════════════════════════════════════════════════════════
//  AGENDIO SaaS — shared/firebase.js
//  Configuração central do Firebase + helpers compartilhados
//  IMPORTANTE: Substitua os valores de firebaseConfig com os seus
//  do Firebase Console → Configurações do projeto → Seus apps
// ═══════════════════════════════════════════════════════════════

// ── FIREBASE CONFIG ─────────────────────────────────────────────
// Cole aqui as credenciais do seu projeto Firebase
const firebaseConfig = {
  apiKey:            "COLE_SEU_API_KEY_AQUI",
  authDomain:        "SEU_PROJETO.firebaseapp.com",
  projectId:         "SEU_PROJETO",
  storageBucket:     "SEU_PROJETO.appspot.com",
  messagingSenderId: "SEU_SENDER_ID",
  appId:             "SEU_APP_ID"
};

// ── INICIALIZAÇÃO ────────────────────────────────────────────────
// Inicializa o Firebase apenas uma vez (padrão singleton)
if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db   = firebase.firestore();  // Banco de dados Firestore
const auth = firebase.auth();       // Autenticação Firebase

// ═══════════════════════════════════════════════════════════════
//  ESTRUTURA DO BANCO DE DADOS (documentação)
//
//  businesses/{business_id}               → doc de cada negócio
//    .nome_negocio   string
//    .slug           string (ex: "barbearia-do-joao")
//    .owner_uid      string (Firebase Auth UID)
//    .status         "ativo" | "vencido" | "cancelado"
//    .plano          "pioneiro" | "pro"
//    .data_vencimento Timestamp
//    .config         { ...settings do negócio... }
//    .createdAt      Timestamp
//    .updatedAt      Timestamp
//
//  businesses/{business_id}/appointments/{date}/{time}
//    .name           string
//    .phone          string
//    .code           string (4 chars)
//    .bookedAt       number (ms)
//    .arrived        bool
//    .freed          bool
//    .freedAt        number|null
//    .countdownStart number|null
//    .cancelled      bool
//    .cancelledAt    number|null
//
//  businesses/{business_id}/logs/{log_id}
//    .type           "error" | "info" | "warning"
//    .message        string
//    .data           object (contexto extra)
//    .timestamp      Timestamp
//
//  payments_log/{event_id}                → webhooks Kiwify
//    .business_id    string
//    .event          "purchase" | "renewal" | "cancellation" | "refund"
//    .amount         number
//    .kiwify_order_id string
//    .timestamp      Timestamp
//
// ═══════════════════════════════════════════════════════════════

// ── LOGGER ──────────────────────────────────────────────────────
// Sistema de logs: salva no Firestore + console
const Logger = {
  /**
   * Loga um erro no Firestore e no console.
   * @param {string} businessId - ID do negócio (pode ser null para erros globais)
   * @param {string} message    - Descrição do erro
   * @param {object} data       - Dados adicionais de contexto
   */
  async error(businessId, message, data = {}) {
    console.error(`[AGENDIO ERROR] ${message}`, data);
    await Logger._save(businessId, 'error', message, data);
  },

  async info(businessId, message, data = {}) {
    console.info(`[AGENDIO INFO] ${message}`, data);
    await Logger._save(businessId, 'info', message, data);
  },

  async warn(businessId, message, data = {}) {
    console.warn(`[AGENDIO WARN] ${message}`, data);
    await Logger._save(businessId, 'warning', message, data);
  },

  // Método interno: grava no Firestore
  async _save(businessId, type, message, data) {
    try {
      const logRef = businessId
        ? db.collection('businesses').doc(businessId).collection('logs')
        : db.collection('global_logs');

      await logRef.add({
        type,
        message,
        data: data || {},
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        userAgent: navigator.userAgent,
      });
    } catch (e) {
      // Falha silenciosa — não deixamos o log quebrar o sistema
      console.error('[Logger falhou ao salvar]', e);
    }
  }
};

// ── SUBSCRIPTION HELPER ─────────────────────────────────────────
// Utilitários para verificar status de assinatura
const Subscription = {
  /**
   * Verifica se um negócio tem assinatura ativa.
   * @param {object} businessDoc - Documento do Firestore do negócio
   * @returns {boolean}
   */
  isActive(businessDoc) {
    if (!businessDoc) return false;
    if (businessDoc.status !== 'ativo') return false;

    // Verifica se a data de vencimento ainda é futura
    if (businessDoc.data_vencimento) {
      const venc = businessDoc.data_vencimento.toDate
        ? businessDoc.data_vencimento.toDate()
        : new Date(businessDoc.data_vencimento);
      if (venc < new Date()) return false;
    }

    return true;
  },

  /**
   * Retorna o status legível da assinatura.
   * @param {object} businessDoc
   * @returns {"ativo"|"vencido"|"cancelado"|"desconhecido"}
   */
  getStatus(businessDoc) {
    if (!businessDoc) return 'desconhecido';
    if (businessDoc.status === 'cancelado') return 'cancelado';
    if (!this.isActive(businessDoc)) return 'vencido';
    return 'ativo';
  },

  /**
   * Retorna quantos dias faltam para vencer (negativo = já venceu).
   * @param {object} businessDoc
   * @returns {number}
   */
  daysLeft(businessDoc) {
    if (!businessDoc?.data_vencimento) return 0;
    const venc = businessDoc.data_vencimento.toDate
      ? businessDoc.data_vencimento.toDate()
      : new Date(businessDoc.data_vencimento);
    const diff = venc.getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }
};

// ── SLUG HELPER ─────────────────────────────────────────────────
// Gera slug a partir do nome do negócio
function generateSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

// ── BUSINESS API ─────────────────────────────────────────────────
// Funções de acesso ao Firestore para dados de negócio
const BusinessAPI = {
  /**
   * Busca um negócio pelo slug (usado na página pública).
   * @param {string} slug - ex: "barbearia-do-joao"
   * @returns {object|null} - { id, ...data } ou null
   */
  async getBySlug(slug) {
    try {
      const snap = await db.collection('businesses')
        .where('slug', '==', slug)
        .limit(1)
        .get();
      if (snap.empty) return null;
      const doc = snap.docs[0];
      return { id: doc.id, ...doc.data() };
    } catch (e) {
      await Logger.error(null, 'getBySlug falhou', { slug, error: e.message });
      return null;
    }
  },

  /**
   * Busca o negócio do usuário logado.
   * @param {string} uid - Firebase Auth UID
   * @returns {object|null}
   */
  async getByOwner(uid) {
    try {
      const snap = await db.collection('businesses')
        .where('owner_uid', '==', uid)
        .limit(1)
        .get();
      if (snap.empty) return null;
      const doc = snap.docs[0];
      return { id: doc.id, ...doc.data() };
    } catch (e) {
      await Logger.error(uid, 'getByOwner falhou', { error: e.message });
      return null;
    }
  },

  /**
   * Cria um novo negócio no Firestore.
   * @param {string} uid      - UID do dono
   * @param {string} email    - Email do dono
   * @param {object} settings - Configurações iniciais
   * @returns {string} - ID do negócio criado
   */
  async create(uid, email, settings) {
    const slug = generateSlug(settings.shopName);

    // Garante que o slug é único (adiciona sufixo se necessário)
    const existing = await this.getBySlug(slug);
    const finalSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;

    // Data de vencimento: 7 dias de trial gratuito
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);

    const businessData = {
      nome_negocio: settings.shopName,
      slug: finalSlug,
      owner_uid: uid,
      owner_email: email,
      status: 'ativo',               // começa ativo no trial
      plano: 'trial',
      data_vencimento: firebase.firestore.Timestamp.fromDate(trialEnd),
      config: settings,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('businesses').add(businessData);
    await Logger.info(ref.id, 'Negócio criado', { slug: finalSlug, email });
    return ref.id;
  },

  /**
   * Atualiza configurações do negócio (somente o dono pode chamar isso).
   * @param {string} businessId
   * @param {object} settings
   */
  async updateConfig(businessId, settings) {
    await db.collection('businesses').doc(businessId).update({
      config: settings,
      nome_negocio: settings.shopName,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
};

// ── APPOINTMENTS API ─────────────────────────────────────────────
// Funções de acesso a agendamentos no Firestore
const AppointmentsAPI = {
  /**
   * Retorna todos os agendamentos de um dia para um negócio.
   * @param {string} businessId
   * @param {string} dateKey - "2025-03-12"
   * @returns {object} - { "09:00": {...}, "10:00": {...} }
   */
  async getDayAppointments(businessId, dateKey) {
    try {
      const snap = await db
        .collection('businesses').doc(businessId)
        .collection('appointments').doc(dateKey)
        .get();
      return snap.exists ? snap.data() : {};
    } catch (e) {
      await Logger.error(businessId, 'getDayAppointments falhou', { dateKey, error: e.message });
      return {};
    }
  },

  /**
   * Salva um agendamento completo do dia (sobrescreve o doc do dia).
   * Esta estratégia mantém compatibilidade com a estrutura original.
   * @param {string} businessId
   * @param {string} dateKey
   * @param {object} dayData - Objeto com todos os slots do dia
   */
  async saveDayAppointments(businessId, dateKey, dayData) {
    await db
      .collection('businesses').doc(businessId)
      .collection('appointments').doc(dateKey)
      .set(dayData, { merge: false });
  },

  /**
   * Atualiza um único slot de um dia.
   * @param {string} businessId
   * @param {string} dateKey
   * @param {string} time  - "09:00"
   * @param {object} data  - Dados do agendamento
   */
  async updateSlot(businessId, dateKey, time, data) {
    await db
      .collection('businesses').doc(businessId)
      .collection('appointments').doc(dateKey)
      .set({ [time]: data }, { merge: true });
  }
};

// ── PAYMENTS API ─────────────────────────────────────────────────
// Registro de eventos de pagamento (para auditoria e debug)
const PaymentsAPI = {
  /**
   * Registra um evento de pagamento vindo do webhook.
   * Chamado pela Cloud Function — não direto pelo browser.
   * @param {object} event
   */
  async logEvent(event) {
    await db.collection('payments_log').add({
      ...event,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
  },

  /**
   * Ativa assinatura de um negócio (chamado pelo webhook).
   * @param {string} businessId
   * @param {string} plano
   * @param {number} diasValidade - Quantos dias de acesso
   */
  async activate(businessId, plano, diasValidade = 31) {
    const venc = new Date();
    venc.setDate(venc.getDate() + diasValidade);

    await db.collection('businesses').doc(businessId).update({
      status: 'ativo',
      plano,
      data_vencimento: firebase.firestore.Timestamp.fromDate(venc),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await Logger.info(businessId, 'Assinatura ativada', { plano, diasValidade });
  },

  /**
   * Cancela assinatura de um negócio.
   * @param {string} businessId
   */
  async cancel(businessId) {
    await db.collection('businesses').doc(businessId).update({
      status: 'cancelado',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await Logger.info(businessId, 'Assinatura cancelada');
  }
};
