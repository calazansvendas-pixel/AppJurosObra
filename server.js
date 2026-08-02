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
    const { nome, email, senha, celular, creci, perfil } = req.body || {};

    if (!email || !senha) {
      return res.status(400).json({ success: false, message: 'E-mail e senha são obrigatórios.' });
    }

    const emailClean = String(email).trim().toLowerCase();
    const passClean = String(senha);
    const nomeClean = String(nome || '').trim();
    const celularClean = String(celular || '').trim();
    const creciClean = String(creci || '').trim();
    const perfilClean = String(perfil || 'Corretor').trim();

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

    // 2. Grava os dados do usuário no Firestore
    const userData = {
      nome: nomeClean,
      email: emailClean,
      celular: celularClean,
      creci: creciClean,
      role: perfilClean === "Administrador" ? "admin" : "corretor",
      perfil: perfilClean,
      status: "pendente",
      createdAt: new Date().toISOString()
    };

    try {
      await getFirestore().collection('usuarios').doc(uid).set(userData);
    } catch (fsError) {
      console.warn("getFirestore().doc().set falhou, tentando fallback via REST API:", fsError?.message);
      const apiKey = "AIzaSyAeDyh0mYtakjGED6c0gIFW-J35zJ52qJ8";
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/juros-obra-ea823/databases/(default)/documents/usuarios?documentId=${uid}&key=${apiKey}`;
      await fetch(firestoreUrl, {
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
      }).catch(err => console.warn("Erro no fallback REST do Firestore:", err));
    }

    return res.json({ success: true, message: "Cadastro realizado com sucesso! Aguarde a aprovação do administrador." });

  } catch (error) {
    console.error("Erro na rota /api/cadastrar:", error);
    return res.status(500).json({ success: false, message: error?.message || "Erro interno ao cadastrar usuário." });
  }
});






// API proxy for Banco Central do Brasil TR data to prevent CORS issues
app.get('/api/tr', async (req, res) => {
  try {
    const response = await fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.226/dados/ultimos/1?formato=json');
    if (!response.ok) {
      throw new Error(`BCB API error: ${response.statusText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error proxying TR from BCB:', err);
    res.status(500).json({ error: 'Failed to fetch TR data' });
  }
});

// Serve static assets from root
app.use(express.static(__dirname));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
