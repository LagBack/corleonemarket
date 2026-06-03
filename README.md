Corleone Market é um simulador completo de bolsa de valores fictícia com backend Node.js, mercado em tempo real, sistema de autenticação, compra e venda de ações, ranking de investidores e painel de administração completo.

 Preços atualizados automaticamente a cada **2.5 segundos** via simulador server-side
- Gráfico de linha interativo com histórico de preços
- Ticker rolando com todas as ações e variações
- Book de ofertas (bids/asks) ao vivo
- Índice **IBCX** calculado em tempo real
- **Eventos de notícia** aleatórios a cada ~90s (escândalos, contratos, investigações) que impactam preços
- **Mean reversion** — preços retornam gradualmente ao valor inicial, evitando deflação/inflação infinita

| Categoria | Tecnologia |
|-----------|-----------|
| Runtime | Node.js |
| Framework | Express 4 |
| Banco de dados | lowdb (JSON file) |
| Autenticação | express-session + bcryptjs |
| Upload | multer |
| IDs únicos | uuid |
| Frontend | HTML + CSS + Vanilla JS |
| Gráficos | Chart.js 4 |
| Dev | nodemon |