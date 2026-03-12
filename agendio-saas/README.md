# Agendio SaaS — Guia de Configuração Completo

## O que mudou em relação à versão anterior

| Versão original | Versão SaaS |
|---|---|
| localStorage (dados no navegador) | Firestore (banco de dados na nuvem) |
| 1 negócio por instância | Multi-tenant (N negócios) |
| URL única | URLs por negócio: `/barbearia-do-joao` |
| Sem login | Firebase Auth (email + senha) |
| Sem assinatura | Status: ativo / vencido / cancelado |
| Sem logs | Sistema de logs no Firestore |
| Sem integração de pagamento | Webhook Kiwify pronto |

---

## Estrutura de arquivos

```
agendio-saas/
├── public/
│   └── index.html          ← Página pública de agendamento (por slug)
├── admin/
│   └── index.html          ← Painel administrativo (requer login)
├── shared/
│   ├── firebase.js         ← Config Firebase + APIs (BusinessAPI, AppointmentsAPI, etc.)
│   ├── business-logic.js   ← Lógica de negócio reutilizada do sistema original
│   └── style.css           ← CSS original preservado
├── functions/
│   └── kiwify-webhook.js   ← Cloud Function para receber pagamentos da Kiwify
├── firestore.rules         ← Regras de segurança do Firestore
└── README.md               ← Este arquivo
```

---

## PASSO 1 — Criar o projeto no Firebase

1. Acesse https://console.firebase.google.com
2. Clique em **"Adicionar projeto"**
3. Nome do projeto: `agendio-saas` (ou qualquer nome)
4. Pode desativar Google Analytics (opcional)
5. Aguarde criar → **Continuar**

---

## PASSO 2 — Ativar Authentication (email/senha)

1. No menu lateral → **Authentication**
2. Clique em **"Começar"**
3. Aba **"Sign-in method"**
4. Clique em **"E-mail/senha"** → Ativar → **Salvar**

---

## PASSO 3 — Criar o Firestore Database

1. No menu lateral → **Firestore Database**
2. Clique em **"Criar banco de dados"**
3. Selecione **"Iniciar no modo de produção"**
4. Região: **`southamerica-east1`** (São Paulo)
5. Clique em **Próximo** → **Ativar**

---

## PASSO 4 — Aplicar as regras de segurança

1. No Firestore → aba **"Regras"**
2. Apague o conteúdo atual
3. Cole o conteúdo do arquivo `firestore.rules`
4. Clique em **"Publicar"**

---

## PASSO 5 — Pegar as credenciais do Firebase

1. No menu → ícone de engrenagem → **"Configurações do projeto"**
2. Role até **"Seus apps"** → clique em **"</>"** (Web)
3. Nome do app: `agendio-web` → **"Registrar app"**
4. Você verá um objeto `firebaseConfig` assim:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "agendio-saas.firebaseapp.com",
  projectId: "agendio-saas",
  storageBucket: "agendio-saas.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc..."
};
```

5. **Cole esses valores em `shared/firebase.js`** no lugar dos placeholders

---

## PASSO 6 — Configurar o roteamento (URL por negócio)

O sistema usa o formato `agendio.com/barbearia-do-joao`.

### Opção A: Netlify (recomendado — grátis)

1. Crie conta em https://netlify.com
2. Drag & drop da pasta `agendio-saas/` para o Netlify
3. Crie um arquivo `netlify.toml` na raiz:

```toml
[[redirects]]
  from = "/admin"
  to = "/admin/index.html"
  status = 200

[[redirects]]
  from = "/admin/*"
  to = "/admin/index.html"
  status = 200

[[redirects]]
  from = "/:slug"
  to = "/public/index.html"
  status = 200
```

### Opção B: Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
```

No `firebase.json`:
```json
{
  "hosting": {
    "public": ".",
    "rewrites": [
      { "source": "/admin/**", "destination": "/admin/index.html" },
      { "source": "/:slug",    "destination": "/public/index.html" }
    ]
  }
}
```

---

## PASSO 7 — Configurar o webhook da Kiwify

### 7A — Deploy da Cloud Function

```bash
cd agendio-saas/
npm install -g firebase-tools
firebase login
firebase init functions
# Escolha: JavaScript, instalar dependências: Sim

cd functions/
npm install
# Copie o conteúdo de kiwify-webhook.js para functions/index.js

# Configure o segredo (pegue na Kiwify → Configurações → Webhooks)
firebase functions:config:set kiwify.secret="SEU_SEGREDO_KIWIFY"

firebase deploy --only functions:kiwifyWebhook
```

### 7B — Configurar na Kiwify

1. Na Kiwify → **Configurações** → **Webhooks**
2. Cole a URL da Cloud Function:
   `https://us-central1-SEU_PROJETO.cloudfunctions.net/kiwifyWebhook`
3. Selecione os eventos:
   - ✅ `order_approved`
   - ✅ `order_refunded`
   - ✅ `subscription_active`
   - ✅ `subscription_cancelled`
   - ✅ `subscription_expired`
4. Copie o **segredo gerado** e configure no Firebase (passo 7A)

---

## Como funciona o fluxo completo

### Novo cliente comprando o Agendio:
1. Acessa a página de vendas → clica em comprar → vai para o Kiwify
2. Kiwify processa o pagamento → dispara webhook
3. Cloud Function recebe → busca o negócio pelo email → ativa a assinatura por 31 dias
4. Dono acessa `agendio.com/admin` → faz login com email → vê o painel ativo

### Cliente do dono fazendo agendamento:
1. Acessa `agendio.com/barbearia-do-joao`
2. Sistema busca o negócio pelo slug no Firestore
3. Se assinatura ativa → mostra a agenda
4. Se assinatura vencida → mostra "temporariamente indisponível"
5. Cliente agenda → dados salvos no Firestore sob o `business_id`

### Assinatura vencendo:
1. Kiwify tenta cobrar e não consegue → dispara `subscription_expired`
2. Cloud Function atualiza `status: "vencido"` no Firestore
3. Dono tenta acessar `/admin` → redirecionado para tela de renovação
4. Página pública continua no ar mostrando o aviso de indisponível

---

## Estrutura do banco de dados (Firestore)

```
businesses/
  abc123/                          ← business_id gerado automaticamente
    nome_negocio: "Barbearia do João"
    slug: "barbearia-do-joao"      ← URL pública
    owner_uid: "firebase-auth-uid"
    owner_email: "joao@email.com"
    status: "ativo"
    plano: "pioneiro"
    data_vencimento: Timestamp
    config: { shopName, workDays, ... }
    
    appointments/
      2025-03-12/                  ← data no formato YYYY-MM-DD
        09:00: { name, phone, code, ... }
        10:00: { name, phone, ... }
    
    logs/
      log1/: { type: "info", message: "Agendamento criado", ... }
      log2/: { type: "error", message: "...", ... }

payments_log/
  event1/: { business_id, event, amount, kiwify_order_id, ... }

global_logs/
  log1/: { type: "error", message: "...", ... }
```

---

## Segurança implementada

- ✅ Cada dono só pode editar dados do próprio `business_id` (regras do Firestore)
- ✅ Não é possível mudar o `owner_uid` ou o `slug` após criação
- ✅ Webhook verifica assinatura HMAC-SHA256 da Kiwify
- ✅ Admin Cloud Functions usam Admin SDK (contornam as regras — somente servidor)
- ✅ Senha via Firebase Auth (não armazenada em banco — só hash)
- ✅ Assinatura vencida bloqueia o painel admin mas não remove a página pública

---

## Funcionalidades preservadas do sistema original

Todas as funcionalidades originais foram mantidas:
- ✅ Setup wizard (3 passos) → agora cria conta Firebase
- ✅ 8 tipos de negócio
- ✅ Geração de slots por horário/intervalo/almoço
- ✅ Agendamento com código de cancelamento
- ✅ Cancelamento por código (bloqueado se <30min)
- ✅ No-show timer (10 min → libera slot)
- ✅ Hot slots (horários recém-liberados em destaque)
- ✅ Painel admin com 5 abas
- ✅ Bloqueio de emergência da agenda
- ✅ Folgas e feriados
- ✅ Integração WhatsApp (mensagem pronta)
- ✅ Toast notifications
- ✅ Indicador de força de senha
