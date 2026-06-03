const db = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');



if (db.get('users').size().value() === 0) {
  console.log('🌱 Seeding database...');

  const adminPass = bcrypt.hashSync('admin123', 10);
  const userPass  = bcrypt.hashSync('123456', 10);

  //THIS IS THE INITIAL ACCOUNTS FOR STARTING THE DB.JSON FILE, THEY ARE NOT FINAL AND YOU SHOULD DELETE THEM AFTER YOU MAKE YOUR OWN ACCOUNTS
  //ESTAS SÃO AS CONTAS INICIAIS PARA INICIAR O ARQUIVO DB.JSON. ELAS NÃO SÃO DEFINITIVAS E VOCÊ DEVE EXCLUÍ-LAS APÓS CRIAR SUAS PRÓPRIAS CONTAS.
  const users = [
    {
      id: 'adm1',
      email: 'admin@corleone.com',
      pass: adminPass,
      name: 'Don Corleone',
      nick: 'Il Padrino',
      avatar: '👑',
      photo: null,
      country: '🇮🇹 Itália',
      bio: 'Eu fiz uma oferta que eles não puderam recusar.',
      role: 'admin',
      balance: 999999,
      joined: Date.now()
    },
    {
      id: 'mod1',
      email: 'mod@corleone.com',
      pass: bcrypt.hashSync('mod123', 10),
      name: 'Consigliere',
      nick: 'Il Consigliere',
      avatar: '🎩',
      photo: null,
      country: '🇮🇹 Itália',
      bio: '',
      role: 'moderator',
      balance: 100000,
      joined: Date.now()
    },
    {
      id: 'u1',
      email: 'don@corleone.com',
      pass: userPass,
      name: 'Giovanni Barzini',
      nick: 'Il Barone',
      avatar: '🦁',
      photo: null,
      country: '🇮🇹 Itália',
      bio: '',
      role: 'user',
      balance: 50000,
      joined: Date.now()
    },
    {
      id: 'u2',
      email: 'luca@corleone.com',
      pass: userPass,
      name: 'Luca Brasi',
      nick: 'Il Toro',
      avatar: '🐂',
      photo: null,
      country: '🇺🇸 Estados Unidos',
      bio: '',
      role: 'user',
      balance: 75000,
      joined: Date.now()
    }
  ];

  const stocks = [
    { sym:'CRLNE4', name:'Corleone Holdings',    sector:'Financeiro',  desc:'Holding de investimentos da família Corleone.',    price:85.40,  open:85.40,  shares:5000000,  vol:0.012, status:'active', demand:0.6, supply:0.4, volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'SICIL3', name:'Sicilian Export SA',   sector:'Alimentação', desc:'Exportação de azeites e vinhos premium.',          price:32.70,  open:32.70,  shares:8000000,  vol:0.015, status:'active', demand:0.5, supply:0.5, volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'GODFT4', name:'Godfather Tech',        sector:'Tecnologia',  desc:'Soluções de segurança e criptografia.',           price:124.50, open:124.50, shares:3000000,  vol:0.022, status:'active', demand:0.7, supply:0.3, volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'OLIVE3', name:'OliveOil Corp',         sector:'Alimentação', desc:'Maior produtor de azeite da América Latina.',     price:18.90,  open:18.90,  shares:12000000, vol:0.010, status:'active', demand:0.45,supply:0.55,volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'CAPO5',  name:'Capo Industries',       sector:'Indústria',   desc:'Manufatura de bens de capital.',                  price:47.20,  open:47.20,  shares:4000000,  vol:0.018, status:'active', demand:0.52,supply:0.48,volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'CONSG3', name:'Consigliere Bank',      sector:'Financeiro',  desc:'Banco de investimentos e assessoria.',            price:63.80,  open:63.80,  shares:2500000,  vol:0.009, status:'active', demand:0.58,supply:0.42,volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'OMERT3', name:'Omerta Security',       sector:'Tecnologia',  desc:'Empresa de cibersegurança e compliance.',        price:55.10,  open:55.10,  shares:3500000,  vol:0.020, status:'active', demand:0.55,supply:0.45,volume:0, buys:0, sells:0, created:Date.now() },
    { sym:'FAMLG4', name:'Famiglia Logistics',   sector:'Transporte',  desc:'Logística e distribuição premium.',               price:29.30,  open:29.30,  shares:6000000,  vol:0.014, status:'active', demand:0.48,supply:0.52,volume:0, buys:0, sells:0, created:Date.now() },
  ];

  const portfolios = {
    u1: { CRLNE4: 80, SICIL3: 200 },
    u2: { GODFT4: 25, CAPO5: 150 },
    mod1: { CONSG3: 100 },
    adm1: {}
  };

  // Deduct initial holdings from balances
  users.find(u => u.id === 'u1').balance -= 80*85.40 + 200*32.70;
  users.find(u => u.id === 'u2').balance -= 25*124.50 + 150*47.20;
  users.find(u => u.id === 'mod1').balance -= 100*63.80;

  db.set('users', users).write();
  db.set('stocks', stocks).write();
  db.set('portfolios', portfolios).write();

  console.log('✅ Database seeded!\n');
  console.log('  👑 Admin:     admin@corleone.com  / admin123');
  console.log('  🎩 Moderador: mod@corleone.com    / mod123');
  console.log('  🦁 Usuário:   don@corleone.com    / 123456');
  console.log('  🐂 Usuário:   luca@corleone.com   / 123456\n');
}
