# Guia da API do NaCal

Guia para quem vai trabalhar na API pela primeira vez. Explica a API com diagramas: o que existe, como as peças conversam e o que acontece em cada fluxo, passo a passo.

> Os diagramas são [Mermaid](https://mermaid.js.org/) e aparecem desenhados no GitHub e no preview de Markdown do VS Code. Para editar com preview ao vivo, use o [Mermaid Live Editor](https://mermaid.live).

## Comece por aqui

Leia nesta ordem:

1. **[Visão geral](01-visao-geral.md)**: com que serviços a API conversa, quais peças da AWS existem e qual Lambda é disparada por quê.
2. **[Arquitetura do código](02-arquitetura-codigo.md)**: camadas, injeção de dependência e o caminho de uma request desde o API Gateway até a resposta.
3. **[Fluxo de refeição por foto ou áudio](fluxos/refeicao-foto-audio.md)**: o fluxo principal do produto, assíncrono, com fila, IA e estorno de cota.

Depois, vá direto ao fluxo em que vai mexer (tabela abaixo). As páginas 03 a 06 servem de consulta.

O setup local, as variáveis de ambiente e o deploy estão no [README da API](../../README.md).

## Mapa do guia

### Fundamentos

| Página | Conteúdo |
|---|---|
| [01 · Visão geral](01-visao-geral.md) | Contexto, peças da AWS e inventário de Lambdas |
| [02 · Arquitetura do código](02-arquitetura-codigo.md) | Camadas, DI, adapters, ciclo de vida da request e como criar um endpoint |
| [03 · Modelo de dados](03-modelo-de-dados.md) | Entidades, access patterns (leituras e escritas condicionais), item collections com atributos e S3 |
| [04 · Máquinas de estado](04-maquinas-de-estado.md) | Refeição, assinatura e conta/onboarding |
| [05 · Erros, cotas e rate limit](05-erros-cotas-rate-limit.md) | Catálogo de códigos, cotas Free/Pro e limites por rota |
| [06 · Operação](06-operacao.md) | Ambientes, deploy, alarmes, logs, runbooks e custos |

### Fluxos

| Domínio | Página | Conteúdo |
|---|---|---|
| Refeição | [Foto ou áudio](fluxos/refeicao-foto-audio.md) | Upload direto no S3, fila, gate, IA, retry com lease, estorno e refeição presa |
| Refeição | [Texto](fluxos/refeicao-texto.md) | Fluxo síncrono, sem S3 nem fila |
| Refeição | [Consultar, editar e excluir](fluxos/refeicao-itens.md) | Listagem do dia, adicionar, remover e restaurar itens, exclusão |
| Conta | [Cadastro por e-mail](fluxos/auth-cadastro-email.md) | Sign-up, `PendingSignUp`, confirmação e criação da conta |
| Conta | [Login com Google](fluxos/auth-google-oauth.md) | OAuth + PKCE, usuário shadow e onboarding |
| Conta | [Login, refresh e senha](fluxos/auth-login-senha.md) | Sign-in, tokens, `GET /me` e esqueci a senha |
| Conta | [Perfil e meta](fluxos/perfil-e-meta.md) | Cálculo da meta diária e edição |
| Billing | [Planos, trial, checkout e webhook](fluxos/billing.md) | Asaas, estados da assinatura e cancelamento |
| Billing | [Reconciliação](fluxos/billing-reconciliacao.md) | Rede de segurança horária do webhook |

### Runbooks

| Página | Conteúdo |
|---|---|
| [Exclusão de conta](runbooks/exclusao-de-conta.md) | Exclusão manual de uma conta em prod durante o beta (LGPD): Asaas, S3, DynamoDB e Cognito |

## Modelo de página de fluxo

Toda página em `fluxos/` segue a mesma ordem, para dar para pular direto ao que interessa:

1. **Resumo**: o fluxo em 2 ou 3 linhas.
2. **Diagrama de sequência**: quem chama quem, na ordem.
3. **Passo a passo**: o que cada etapa faz e por quê.
4. **Erros e casos de borda**: o que dá errado e como o sistema reage.
5. **Arquivos envolvidos**: links para o código.

## Glossário

| Termo | Significado |
|---|---|
| **accountId** / **internalId** | ID do usuário na API. Vem no claim `internalId` do access token do Cognito e é a chave de quase tudo no DynamoDB. |
| **Single-table** | Todas as entidades (conta, perfil, meta, refeição, assinatura, cadastro pendente e vínculos com o Asaas) moram numa tabela só do DynamoDB (`MainTable`), separadas pelo prefixo da chave. |
| **Use case** | Classe com uma única ação de negócio (`CreateMealUseCase`, `ProcessMealUseCase`). É onde fica a regra. |
| **Gateway** | Classe que conversa com um serviço externo (S3, SQS, OpenAI, Asaas). O use case nunca chama um SDK direto. |
| **Adapter** | Função em `src/main/adapters/` que transforma o evento da Lambda (HTTP, SQS, S3, schedule) na chamada de uma classe da aplicação. |
| **Presigned POST** | Formulário assinado pelo S3 que deixa o app subir o arquivo direto no bucket, sem passar pela Lambda. |
| **Gate** | Checagem rápida e barata (Cloudflare Workers AI) que barra fotos sem comida antes de gastar com a OpenAI. |
| **Lease** | "Reserva" com prazo que uma Lambda grava na refeição ao começar a processá-la, para outra Lambda não processar a mesma refeição ao mesmo tempo. |
| **Estorno de cota** | Devolver ao usuário a refeição que foi contada na cota quando o processamento não chegou ao fim (rejeição ou falha). |
| **DLQ** | Dead Letter Queue: fila para onde vão as mensagens que falharam todas as tentativas. Toda DLQ tem alarme, que manda e-mail em prod. |
| **Free / Pro** | Planos. Free: 20 refeições com IA por mês. Pro: até 20 por dia (uso justo). |

## Mantendo o guia em dia

Ao mudar um fluxo, atualize o diagrama da página correspondente no mesmo commit. Diagrama desatualizado é pior do que nenhum diagrama.
