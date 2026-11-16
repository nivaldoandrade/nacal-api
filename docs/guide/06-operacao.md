# 06 · Operação

Como colocar a API no ar, acompanhar o que está rodando e agir quando algo dá errado.

## Ambientes

| | dev | prod |
|---|---|---|
| Conta AWS | Pessoal (perfil `default`) | `nacal-prod`, numa AWS Organization (perfil `nacal-prod`, via Identity Center) |
| Stack | `nacal-api-dev` | `nacal-api-prod` (com termination protection) |
| Variáveis | `.env` | `.env.prod`, validado por `yarn check:prod` |
| Domínio | Endpoint padrão do API Gateway | `api.nacal.app` |
| Asaas | Sandbox | Produção |
| Alarmes | Criados, mas desligados | Ligados, com e-mail |
| Reconciliação | Desligada | Ligada |

O checklist da conta de produção (certificados, SES, Google, Asaas, CloudTrail, GuardDuty) é um documento interno, fora deste repo. Peça ao responsável pelo projeto.

## Deploy

```bash
# dev: stack inteira
sls deploy

# dev: só uma função (mais rápido, só código)
sls deploy function -f processMeal

# prod: valida o .env.prod e faz o deploy
AWS_PROFILE=nacal-prod yarn deploy:prod

# prod: só uma função
AWS_PROFILE=nacal-prod sls deploy function -f processMeal --stage prod
```

- `sls deploy function` **não** atualiza variáveis de ambiente, recursos nem rotas. Mudou qualquer coisa em `sls/` ou no `.env`: deploy completo.
- O Serverless v4 exige `sls login`.
- Antes do deploy: `yarn typecheck` e `npx eslint .` (não há testes automatizados).
- **Nunca rode `sls remove` em prod.** Em prod, há três camadas de proteção:
  - **Stack**: a termination protection do `nacal-api-prod` faz o `sls remove` falhar antes de apagar qualquer coisa. Ela foi ligada à mão (2026-11-11) e não está no `serverless.yml`.
  - **Dados**: as duas tabelas (`DeletionProtectionEnabled`) e o user pool (`DeletionProtection: ACTIVE`) recusam a exclusão. As três proteções valem só com a condição `IsProd`.
  - **Arquivos**: o bucket de refeições tem `DeletionPolicy: Retain` e sobrevive à remoção da stack, em qualquer stage.

  As tabelas e o user pool não têm `DeletionPolicy: Retain`. Se a termination protection for desligada, a remoção da stack falha nesses recursos em vez de preservá-los fora da stack, e o resto (Lambdas, filas, API Gateway, CloudFront) é apagado. Em dev nada disso está ligado, exceto o `Retain` do bucket.

## Alarmes

Todos publicam no tópico SNS `DQLAlarmTopic` (o nome é esse mesmo, com `DQL`, é como aparece no console), que manda e-mail para `DLQ_ALARM_EMAIL`. Os alarmes do CloudWatch só ficam ativos em prod; os alertas do código (estorno e chargeback, pagamento de outra assinatura, reconciliação) também saem em dev. O que fazer com cada e-mail, com exemplos e comandos: [runbook de alertas](runbooks/alertas.md).

| Alarme | Dispara quando | Significa | O que fazer |
|---|---|---|---|
| `MealsDLQAlarm` | Alguma mensagem na `MealsDLQ` | Uma refeição esgotou as 3 entregas sem conseguir nem marcar `FAILED` | Ver os logs da `processMeal` pelo `mealId` da mensagem. A refeição pode ter ficado presa sem estorno. |
| `MealsQueueAgeAlarm` | Mensagem mais antiga da `MealsQueue` passa de 2 min, por 2 min seguidos | O processamento está atrasado ou parado | Ver erros e throttling da `processMeal` e a disponibilidade da OpenAI |
| `MealUploadCheckDLQAlarm` | Alguma mensagem na `MealUploadCheckDLQ` | A checagem de 15 min falhou 3 vezes | Ver os logs da `checkMealUpload` e conferir a refeição e a cota na mão |
| `ReconcilePaymentsErrorsAlarm` | Erro na Lambda `reconcilePayments` | A reconciliação não rodou | Ver os logs. Ela roda de novo na hora seguinte. |
| `HttpApi5xxAlarm` | 3 ou mais respostas `5xx` do HTTP API em 5 min | Erro não tratado, `502` do Asaas ou do Cognito, Lambda com timeout | Ver [runbook de alertas](runbooks/alertas.md#httpapi5xxalarm) |
| `AsaasWebhookNon2xxAlarm` | 1 ou mais respostas não-2xx dadas pelo código do webhook do Asaas em 5 min (métrica `WebhookNon2xx`) | IP fora da allowlist, token errado, conflito de escrita ou erro. Throttle (`reservedConcurrency: 5`), timeout ou erro de init não passam pelo código: só aparecem no `HttpApi5xxAlarm` | Ver [runbook de alertas](runbooks/alertas.md#asaaswebhooknon2xxalarm). O Asaas pausa a fila do webhook depois de 15 falhas seguidas |
| `MealFailedAlarm` | 1 ou mais refeições `FAILED` em 15 min (métrica `MealFailed`) | Uma refeição foi perdida (a cota já foi estornada) | Ver [runbook de alertas](runbooks/alertas.md#mealfailedalarm) |
| `NewMealUploadedTriggerErrorsAlarm` | 1 ou mais erros da `newMealUploadedTrigger` em 5 min (conta cada tentativa, inclusive as que dão certo na repetição) | O evento de upload do S3 não virou mensagem na `MealsQueue` | Ver [runbook de alertas](runbooks/alertas.md#newmealuploadedtriggererrorsalarm) |
| `ProcessMealThrottlesAlarm` | 1 ou mais throttles da `processMeal` em 5 min | A conta bateu o limite de concorrência das Lambdas | Ver [runbook de alertas](runbooks/alertas.md#processmealthrottlesalarm) |
| E-mail "reconciliação encontrou divergências" | Pagamento ativado ou estorno aplicado pela reconciliação, sem conta ou com erro | O webhook falhou ou um pagamento não tem dono | Ver [runbook de alertas](runbooks/alertas.md#reconciliação-encontrou-divergências) |
| E-mail "estorno ... · Pro descontado/sem mudança" | Evento de estorno ou chargeback no webhook do Asaas | O Pro foi descontado ou não, conforme o caso | Ver [runbook de alertas](runbooks/alertas.md#estorno-e-chargeback) |
| E-mail "pagamento de outra assinatura com o Pro ativo" | Pagamento que não é da assinatura guardada | Pode haver duas cobranças ativas | Ver [runbook de alertas](runbooks/alertas.md#pagamento-de-outra-assinatura-com-o-pro-ativo) |
| GuardDuty (findings de severidade média para cima) | Atividade suspeita na conta | — | Configurado à mão em prod, fora do `serverless.yml` |

As DLQs guardam mensagens por 14 dias.

## Logs

```bash
sls logs -f processMeal --tail                   # dev
AWS_PROFILE=nacal-prod sls logs -f processMeal --stage prod --startTime 1h
```

- **Formato**: uma linha JSON por evento, com `timestamp`, `level` (`INFO`, `WARN`, `ERROR`), `message` e os campos do contexto (`awsRequestId`, `routeKey`, `accountId`, `messageId`, `mealId`). Detalhes em [arquitetura](02-arquitetura-codigo.md#logger). As linhas de início e fim da Lambda (`START`, `END`, `REPORT`) continuam em texto.
- **Retenção**: 30 dias em todos os log groups (`provider.logRetentionInDays`).
- **Access log do HTTP API**: `/aws/http-api/nacal-api-<stage>`, uma linha por request com IP, rota e status. Mostra também o que não chega na Lambda (`401` do authorizer, rota inexistente).
- **Sourcemaps**: o build gera `.js.map` (sem o código-fonte embutido) e o Serverless põe `NODE_OPTIONS=--enable-source-maps` em cada função, então a stack de um erro aponta para o arquivo e a linha do `src/`. O `keepNames` do esbuild mantém o nome das classes de erro (`error.name` sai `BillingError`, não o nome minificado).

Marcadores úteis para buscar no CloudWatch Logs Insights (campo `message`):

| `message` | Onde aparece | Mostra |
|---|---|---|
| `http request` | Lambdas HTTP | Uma linha por request: `routeKey`, `statusCode`, `durationMs`, `errorCode` e, nos `5xx`, o `error` |
| `sqs message failed` | `processMeal`, `checkMealUpload` | Mensagem que voltou para a fila, com `messageId`, `receiveCount` e o `error` |
| `meal processing started`, `meal processed`, `meal rejected`, `meal processing attempt failed` | `processMeal` | Transições de uma refeição, com `mealId`, `attempt` e `durationMs` |
| `metric MealFailed` | `processMeal`, `checkMealUpload` | Refeição que virou `FAILED`, com o `source` |
| `metric WebhookNon2xx` | `webhookAsaas` | Resposta não-2xx do webhook, com `statusCode` e `errorCode` |
| `openai response` | Lambdas de refeição | `usage` de cada chamada à OpenAI (`inputTokens`, `cachedTokens`, `outputTokens`, `reasoningTokens`), `operation`, `responseStatus` e `durationMs` |
| `openai transcription` | `processMeal` | Transcrição do áudio, com `usage` e `durationMs` |
| `meal_gate` | `processMeal` | Decisão, score, latência e tokens do gate |
| `meal_gate_error` | `processMeal` | Falha ou timeout do gate (a foto seguiu sem ele) |
| `unidentified foods removed` | `processMeal`, `createTextMeal`, `addMealItems` | Alimentos removidos por não estarem identificados |
| `billing reconciliation` | `reconcilePayments` | Resumo de cada execução |
| `failed to refund meal quota` | `createMeal` | Estorno de cota que falhou na criação (conferir o contador na mão). No `createTextMeal`, a mesma falha sai no `error` da linha `http request` do `500` (`AggregateError` com "refund meal quota") |

Exemplo no Logs Insights (tokens por operação na última semana):

```text
fields operation, usage.inputTokens, usage.cachedTokens, usage.outputTokens, usage.reasoningTokens
| filter message = "openai response"
| stats count() as calls, avg(usage.inputTokens) as input, avg(usage.outputTokens) as output, max(usage.outputTokens) as maxOutput by operation
```

## Runbooks e scripts

| Tarefa | Onde |
|---|---|
| Excluir a conta de um usuário (manual, durante o beta) | [Runbook de exclusão de conta](runbooks/exclusao-de-conta.md) |
| Entender um e-mail de alerta, encerrar ou devolver o Pro à mão | [Runbook de alertas](runbooks/alertas.md) |
| Convidar e-mails para o beta | README da API, seção "Convidar para o beta" (`scripts/sendBetaInvites.ts`) |
| Ver os e-mails transacionais renderizados | `npx tsx scripts/previewEmails.ts` (restrições do Cognito em [cadastro por e-mail](fluxos/auth-cadastro-email.md#e-mails)) |
| Criar refeições de teste pela API | `scripts/createMeal.ts`, `scripts/createTextMeal.ts` |
| Rodar a reconciliação na mão | [reconciliação](fluxos/billing-reconciliacao.md#rodar-na-mão) |

## Custos que valem vigiar

| Item | Por quê |
|---|---|
| OpenAI | É o maior custo variável. Cotas e rate limit existem para limitar esse gasto. |
| Cloudflare Workers AI | Gate de foto. Barato, mas cobrado por chamada. |
| GuardDuty | Grátis até 2026-12-12 em prod, depois cobrado. |
| CloudWatch Logs | Ingestão por GB. Retenção de 30 dias (`logRetentionInDays`); as linhas por request e o access log crescem com o tráfego. |
| CloudWatch (alarmes e métricas) | 8 alarmes e 2 métricas EMF (`MealFailed`, `WebhookNon2xx`) custam centavos por mês. |

A estimativa de custos detalhada é um documento interno, fora deste repo.
