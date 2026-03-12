// ═══════════════════════════════════════════════════════════════
//  AGENDIO SaaS — shared/business-logic.js
//  Toda a lógica de negócio reutilizada do sistema original.
//  NÃO foram removidas funcionalidades — apenas adaptado o storage
//  de localStorage para Firestore via callbacks.
// ═══════════════════════════════════════════════════════════════

// ── TIPOS DE NEGÓCIO ─────────────────────────────────────────────
// Mantidos 100% igual ao original
const BUSINESS_TYPES = [
  { id: 'barbearia', label: 'Barbearia',        icon: '💈', color: '#c8440a', service: 'corte'        },
  { id: 'salao',     label: 'Salão de Beleza',   icon: '💇', color: '#b0308a', service: 'serviço'      },
  { id: 'clinica',   label: 'Clínica / Saúde',   icon: '🏥', color: '#2d7a4f', service: 'consulta'     },
  { id: 'tatuagem',  label: 'Estúdio de Tattoo', icon: '🎨', color: '#4a30c8', service: 'sessão'       },
  { id: 'manicure',  label: 'Manicure / Nail',   icon: '💅', color: '#c83070', service: 'atendimento'  },
  { id: 'personal',  label: 'Personal Trainer',  icon: '💪', color: '#c87010', service: 'treino'       },
  { id: 'estetica',  label: 'Estética',           icon: '✨', color: '#708030', service: 'procedimento' },
  { id: 'outro',     label: 'Outro negócio',      icon: '🏪', color: '#555555', service: 'atendimento'  },
];

// ── CONFIGURAÇÕES PADRÃO ─────────────────────────────────────────
// Mantidas 100% igual ao original
const DEFAULT_SETTINGS = {
  shopName:    'Meu Negócio',
  barberName:  'Profissional',
  shopAddress: '',
  bizType:     'barbearia',
  workDays:    [1, 2, 3, 4, 5, 6],
  startTime:   '08:00',
  endTime:     '18:00',
  intervalMin: 30,
  lunchBreak:  'none',
  offDates:    [],
  locked:      false,
  lockedSince: null,
  waNumber:    '',
  rem1h:       true,
  remMorning:  false,
};

// ── CONSTANTES ───────────────────────────────────────────────────
const NO_SHOW_TIMEOUT = 10 * 60 * 1000; // 10 minutos em ms
const DAYS_PT   = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const MONTHS_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// ── HELPERS ──────────────────────────────────────────────────────

/** Retorna o tipo de negócio pelo id, com fallback para o primeiro */
function getBizType(id) {
  return BUSINESS_TYPES.find(b => b.id === id) || BUSINESS_TYPES[0];
}

/** Gera código de cancelamento aleatório de 4 chars */
function genCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/**
 * Gera todos os slots de tempo para um negócio com base nas configurações.
 * Lógica original preservada integralmente.
 * @param {object} settings
 * @returns {string[]} - ["08:00", "08:30", ...]
 */
function generateSlots(settings) {
  const slots = [];
  const [sh, sm] = settings.startTime.split(':').map(Number);
  const [eh, em] = settings.endTime.split(':').map(Number);
  const iv = parseInt(settings.intervalMin);
  let cur = sh * 60 + sm, end = eh * 60 + em, ls = null, le = null;

  // Configura pausa do almoço
  if (settings.lunchBreak !== 'none') {
    const [a, b] = settings.lunchBreak.split('-');
    const [lsh, lsm] = a.split(':').map(Number);
    const [leh, lem] = b.split(':').map(Number);
    ls = lsh * 60 + lsm;
    le = leh * 60 + lem;
  }

  while (cur < end) {
    if (ls !== null && cur >= ls && cur < le) { cur += iv; continue; }
    slots.push(`${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`);
    cur += iv;
  }
  return slots;
}

/**
 * Retorna os próximos 6 dias úteis do negócio.
 * Lógica original preservada.
 * @param {object} settings
 * @returns {Array<{date, key, name, label}>}
 */
function getWeekDays(settings) {
  const days = [], now = new Date();
  let i = 0;
  while (days.length < 6 && i < 30) {
    const d   = new Date(now);
    d.setDate(now.getDate() + i);
    const dow = d.getDay(), key = d.toISOString().slice(0, 10);
    if (settings.workDays.includes(dow))
      days.push({ date: d, key, name: DAYS_PT[dow], label: `${d.getDate()} ${MONTHS_PT[d.getMonth()]}` });
    i++;
  }
  return days;
}

/**
 * Converte dayKey + time em objeto Date.
 * @param {string} dayKey - "2025-03-12"
 * @param {string} time   - "09:00"
 */
function slotDateTime(dayKey, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(dayKey + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Verifica se o negócio está aberto agora.
 * @param {object} settings
 * @returns {boolean}
 */
function isShopOpen(settings) {
  const now = new Date(), dow = now.getDay();
  if (!settings.workDays.includes(dow)) return false;
  if (settings.offDates?.includes(now.toISOString().slice(0, 10))) return false;
  if (settings.locked) return false;
  const [sh, sm] = settings.startTime.split(':').map(Number);
  const [eh, em] = settings.endTime.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

/**
 * Retorna slots livres para um dia.
 * Lógica original preservada — recebe dayData do Firestore em vez do localStorage.
 * @param {string} dayKey
 * @param {object} dayData   - agendamentos do dia vindo do Firestore
 * @param {object} settings
 * @returns {string[]}
 */
function getFreeSlots(dayKey, dayData, settings) {
  const shopSlots = generateSlots(settings);
  const now       = new Date(), todayKey = now.toISOString().slice(0, 10);

  if (settings.offDates?.includes(dayKey)) return [];
  if (settings.locked && dayKey === todayKey) return [];

  return shopSlots.filter(time => {
    const appt = dayData[time];
    if (appt) {
      if (appt.cancelled) return true;
      return !!appt.freed;
    }
    if (dayKey === todayKey && slotDateTime(dayKey, time) < now) return false;
    return true;
  });
}

/**
 * Verifica se um slot foi liberado recentemente (últimos 5min).
 * @param {string} dayKey
 * @param {string} time
 * @param {object} dayData
 */
function isJustFreed(dayKey, time, dayData) {
  const appt = dayData?.[time];
  if (!appt) return false;
  if (appt.freed)     return (Date.now() - appt.freedAt)     < 5 * 60 * 1000;
  if (appt.cancelled) return (Date.now() - appt.cancelledAt) < 5 * 60 * 1000;
  return false;
}

/**
 * Calcula informações do countdown de no-show.
 * @param {object} appt
 * @returns {{ active: boolean, label: string }}
 */
function getCountdownInfo(appt) {
  if (!appt.countdownStart) return { active: false };
  const rem = NO_SHOW_TIMEOUT - (Date.now() - appt.countdownStart);
  if (rem <= 0) return { active: false };
  return {
    active: true,
    label: `${Math.floor(rem/60000)}:${String(Math.floor((rem%60000)/1000)).padStart(2,'0')}`,
  };
}

/**
 * Formata tempo relativo (agora, há Xmin, há Xh).
 * @param {number} ts - timestamp em ms
 */
function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)   return 'agora';
  if (diff < 3600000) return `há ${Math.floor(diff/60000)}min`;
  return `há ${Math.floor(diff/3600000)}h`;
}

/**
 * Verifica força da senha e anima a barra visual.
 * Função original preservada.
 */
function checkPwStrength(inputId, barId) {
  const pw  = document.getElementById(inputId).value;
  const bar = document.getElementById(barId);
  let score = 0;
  if (pw.length >= 4)                          score++;
  if (pw.length >= 8)                          score++;
  if (/[0-9]/.test(pw))                        score++;
  if (/[A-Z]/.test(pw) || /[!@#$%]/.test(pw)) score++;
  const colors = ['#b03030','#c87010','#d4a843','#2d7a4f'];
  const widths = ['25%','50%','75%','100%'];
  bar.style.width      = score ? widths[score-1]  : '0';
  bar.style.background = score ? colors[score-1] : '#3a3a3a';
}
