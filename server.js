import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Inicialização do Firebase Admin SDK
if (!getApps().length) {
  try {
    initializeApp({
      projectId: 'juros-obra-ea823'
    });
  } catch (err) {
    console.error("Erro ao inicializar Firebase Admin:", err);
  }
}

// Endpoint POST para cadastro de novos usuários/corretores
app.post('/api/cadastrar', async (req, res) => {
  try {
    // 'perfil' e 'role' NUNCA são aceitos do corpo da requisição: todo cadastro criado por
    // esta rota é sempre Corretor/pendente. A promoção de perfil só pode ser feita depois,
    // por um Administrador já autenticado, pela tela de Gestão de Usuários.
    const { nome, email, senha, celular, creci } = req.body || {};

    if (!email || !senha) {
      return res.status(400).json({ success: false, message: 'E-mail e senha são obrigatórios.' });
    }

    const emailClean = String(email).trim().toLowerCase();
    const passClean = String(senha);
    const nomeClean = String(nome || '').trim();
    const celularClean = String(celular || '').trim();
    const creciClean = String(creci || '').trim();
    const perfilClean = 'Corretor';

    let uid = null;

    // 1. Tenta criar a conta via Firebase Admin Auth
    try {
      const userRecord = await getAuth().createUser({
        email: emailClean,
        password: passClean,
        displayName: nomeClean
      });
      uid = userRecord.uid;
    } catch (authError) {
      console.warn("getAuth().createUser falhou ou precisa de fallback REST:", authError?.message);
      // Fallback via Firebase Auth Identity Toolkit REST API
      const apiKey = "AIzaSyAeDyh0mYtakjGED6c0gIFW-J35zJ52qJ8";
      const restResp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailClean,
          password: passClean,
          returnSecureToken: true
        })
      });
      const restData = await restResp.json();
      if (!restResp.ok || restData.error) {
        const errMsg = restData.error?.message || "Erro ao criar conta de usuário.";
        let translated = errMsg;
        if (errMsg.includes("EMAIL_EXISTS")) translated = "Este e-mail já está cadastrado.";
        if (errMsg.includes("WEAK_PASSWORD")) translated = "A senha deve ter pelo menos 6 caracteres.";
        return res.status(400).json({ success: false, message: translated });
      }
      uid = restData.localId;
    }

    // 2. Grava os dados do usuário no Firestore. Perfil/role são sempre fixos aqui —
    // nunca vêm do que o cliente enviou.
    const userData = {
      nome: nomeClean,
      email: emailClean,
      celular: celularClean,
      creci: creciClean,
      role: "corretor",
      perfil: perfilClean,
      status: "pendente",
      createdAt: new Date().toISOString()
    };

    // A ficha em 'usuarios' é o que torna o cadastro válido no sistema (é ela que o
    // login e o painel de aprovação enxergam). Se nem o SDK nem o fallback REST
    // confirmarem a gravação, a conta do Auth é revertida (deleteUser) e a API
    // retorna 500 — nunca sucesso sem a ficha gravada, para não criar mais órfãos.
    let firestoreOk = false;
    try {
      await getFirestore().collection('usuarios').doc(uid).set(userData);
      firestoreOk = true;
    } catch (fsError) {
      console.warn("getFirestore().doc().set falhou, tentando fallback via REST API:", fsError?.message);
      try {
        const apiKey = "AIzaSyAeDyh0mYtakjGED6c0gIFW-J35zJ52qJ8";
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/juros-obra-ea823/databases/(default)/documents/usuarios?documentId=${uid}&key=${apiKey}`;
        const fsRestResp = await fetch(firestoreUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              nome: { stringValue: nomeClean },
              email: { stringValue: emailClean },
              celular: { stringValue: celularClean },
              creci: { stringValue: creciClean },
              role: { stringValue: userData.role },
              perfil: { stringValue: perfilClean },
              status: { stringValue: "pendente" },
              createdAt: { stringValue: userData.createdAt }
            }
          })
        });
        firestoreOk = fsRestResp.ok;
        if (!firestoreOk) {
          const errBody = await fsRestResp.text().catch(() => '');
          console.error("Fallback REST do Firestore retornou erro:", fsRestResp.status, errBody);
        }
      } catch (fsRestError) {
        console.error("Erro no fallback REST do Firestore:", fsRestError);
      }
    }

    if (!firestoreOk) {
      try {
        await getAuth().deleteUser(uid);
      } catch (rollbackError) {
        console.error("Rollback falhou: não foi possível apagar a conta órfã no Auth:", uid, rollbackError?.message);
      }
      return res.status(500).json({
        success: false,
        message: "Não foi possível concluir o cadastro. Tente novamente em instantes."
      });
    }

    return res.json({ success: true, message: "Cadastro realizado com sucesso! Aguarde a aprovação do administrador." });

  } catch (error) {
    console.error("Erro na rota /api/cadastrar:", error);
    return res.status(500).json({ success: false, message: error?.message || "Erro interno ao cadastrar usuário." });
  }
});






const BCB_TR_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.226/dados/ultimos/1?formato=json';

// Busca com timeout (evita pendurar a requisição em rede lenta) e algumas
// tentativas com atraso curto, porque falhas de DNS/conexão ao BCB costumam
// ser blips passageiros (poucos segundos), não uma indisponibilidade real.
async function fetchComRetry(url, { tentativas = 3, timeoutMs = 5000, atrasoMs = 600 } = {}) {
  let ultimoErro = null;
  for (let i = 1; i <= tentativas; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return response;
      ultimoErro = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (err) {
      clearTimeout(timer);
      ultimoErro = err;
    }
    console.warn(`TR: tentativa ${i}/${tentativas} falhou (${ultimoErro?.code || ultimoErro?.message || ultimoErro})`);
    if (i < tentativas) await new Promise((r) => setTimeout(r, atrasoMs * i));
  }
  throw ultimoErro;
}

// API proxy for Banco Central do Brasil TR data to prevent CORS issues
app.get('/api/tr', async (req, res) => {
  try {
    const response = await fetchComRetry(BCB_TR_URL);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error proxying TR from BCB:', err?.code || err?.message || err);
    res.status(502).json({ error: 'Failed to fetch TR data', detail: err?.code || err?.message || String(err) });
  }
});

// Serve apenas os arquivos públicos da aplicação — nunca a raiz do projeto.
// express.static(__dirname) expunha server.js, scripts/, package.json etc. como
// texto puro para qualquer requisição GET que combinasse com o caminho do arquivo.
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Qualquer outra rota não mapeada: 404 (nada de fallback servindo arquivos do servidor)
app.use((req, res) => {
  res.status(404).send('Not Found');
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Porta ${PORT} ocupada, tentando porta ${Number(PORT) + 1}...`);
    app.listen(Number(PORT) + 1, '0.0.0.0');
  } else {
    console.error("Erro no servidor:", err);
  }
});
