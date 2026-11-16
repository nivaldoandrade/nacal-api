# Runbook: alertas por e-mail

Escopo: o que significa cada e-mail de alerta da API e o que fazer com ele. Todos chegam pelo tópico SNS `DQLAlarmTopic` (o nome é esse mesmo, com `DQL`), que manda e-mail para `DLQ_ALARM_EMAIL`.

| Assunto do e-mail | Quem manda | Seção |
|---|---|---|
| `NaCal: estorno total · Pro descontado`, `NaCal: estorno parcial · Pro sem mudança`, `NaCal: chargeback aberto · ...` etc. | Webhook do Asaas | [Estorno e chargeback](#estorno-e-chargeback) |
| `NaCal: pagamento de outra assinatura com o Pro ativo` | Webhook do Asaas | [Pagamento de outra assinatura com o Pro ativo](#pagamento-de-outra-assinatura-com-o-pro-ativo) |
| `NaCal: reconciliação de pagamentos encontrou divergências` | Reconciliação horária | [Reconciliação encontrou divergências](#reconciliação-encontrou-divergências) |
| `ALARM: "nacal-api-prod-..."` (8 alarmes, entre eles 5xx do HTTP API, webhook do Asaas não-2xx e refeição `FAILED`) | CloudWatch | [Alarmes do CloudWatch](#alarmes-do-cloudwatch) |
| Findings do GuardDuty | GuardDuty (configurado à mão em prod) | [GuardDuty](#guardduty) |

## Antes de agir

- **É de prod ou de dev?** Os alertas do código (estorno, outra assinatura, reconciliação) também saem em dev, onde o Asaas é o sandbox: são de testes e podem ser ignorados. O rodapé do e-mail do SNS traz o ARN do tópico: `nacal-api-prod-DQLAlarmTopic` é prod, `nacal-api-dev-DQLAlarmTopic` é dev. Os alarmes do CloudWatch só ficam ligados em prod.
- **Os e-mails de billing já dizem o que fazer**: a primeira linha conta o que aconteceu, a linha "O que fazer" diz a ação, e o bloco de baixo traz a conta, o pagamento e o estado da assinatura antes e depois. Esta página detalha cada caso e dá os comandos.
- **Variáveis** usadas nos comandos abaixo:

  ```bash
  export AWS_PROFILE=nacal-prod
  test "$(aws iam list-account-aliases --query 'AccountAliases[0]' --output text)" = "nacal-prod" && echo "conta de prod: ok" || echo "PARE: não é a conta de prod"
  export AWS_REGION=sa-east-1
  export MAIN_TABLE=nacal-api-prod-MainTable
  export ACCOUNT_ID="<a Conta do e-mail>"
  KEY="{\"PK\":{\"S\":\"ACCOUNT#${ACCOUNT_ID}\"},\"SK\":{\"S\":\"ACCOUNT#${ACCOUNT_ID}#SUBSCRIPTION\"}}"
  ```

## Estorno e chargeback

Chega para todo evento de estorno ou chargeback de um pagamento com dono. O assunto diz o evento e se a conta mudou: **"Pro descontado"** (a API tirou o ciclo pago por esse pagamento) ou **"Pro sem mudança"** (só aviso). As regras estão em [billing](../fluxos/billing.md#estorno-e-chargeback).

| Assunto | O que aconteceu | O que fazer |
|---|---|---|
| `estorno total · Pro descontado` | O ciclo pago foi descontado do `paidUntil`. Na mensal, a assinatura do Asaas foi cancelada junto e o Pro acabou. No anual com renovação adiantada, a conta fica com o ano que já tinha pago | Nada, se o estorno foi feito por você. Se não foi, ver no painel do Asaas quem estornou |
| `chargeback aberto · Pro descontado` | O mesmo, por chargeback | Contestar pelo painel do Asaas dentro do prazo, se quiser. Se ganhar, o Pro não volta sozinho ([devolver o Pro](#devolver-o-pro-até-uma-data)) |
| `estorno parcial · Pro sem mudança` | Estorno de parte do valor. O Pro continua | Ver o [exemplo abaixo](#exemplo-estorno-parcial) |
| `chargeback em disputa · Pro sem mudança` | Os documentos da disputa foram enviados. O Pro já foi descontado quando o chargeback foi aberto (o estado "Antes" do e-mail mostra) | Acompanhar a disputa no painel do Asaas |
| `chargeback ganho · Pro sem mudança` | Você ganhou a disputa e falta a adquirente devolver o valor. O Pro não volta sozinho | Se quiser devolver o Pro: [devolver o Pro até uma data](#devolver-o-pro-até-uma-data) |
| `... · Pro sem mudança`, "já tinha sido descontado" | Outro evento do mesmo estorno ou chargeback (por exemplo o `PAYMENT_REFUNDED` depois do chargeback) | Nada |
| `... · Pro sem mudança`, "não é do plano atual" | Pagamento de outra assinatura do Asaas ou de outro plano (ex.: uma mensal antiga depois de assinar o anual) | Ver no painel do Asaas se essa outra assinatura ainda cobra e cancelá-la se sobrou |
| `... · Pro sem mudança`, "ciclo que já passou" | Estorno de um mês antigo, já usado | Nada, a não ser que o estorno devesse encerrar o Pro atual: [encerrar o Pro agora](#encerrar-o-pro-agora) |
| `... · Pro sem mudança`, "não mudou o Pro quando foi confirmado" | O pagamento chegou já coberto por outro (pagamento em dobro) e foi estornado | Nada, se você estornou o pagamento em dobro. Conferir que o outro continua pago |
| `... · Pro sem mudança`, "entrou no lugar de outra que ainda estava ativa" | A conta tinha duas mensais cobrando e o estorno é da que ficou guardada | Cancelar no painel a assinatura que sobrou e, se precisar, ajustar a conta à mão |
| `... · Pro sem mudança`, "não tem assinatura paga" ou "sem data de vencimento" | Não havia o que descontar, ou o evento veio incompleto | Conferir o pagamento no painel do Asaas |

### Exemplo: estorno parcial

O e-mail:

```text
Assunto: NaCal: estorno parcial · Pro sem mudança

Estorno parcial: o Pro da conta continua como está.

O que fazer: Nada a fazer se foi um desconto ou uma compensação. Se a intenção era encerrar o Pro
(ex.: devolução proporcional do anual), faça o estorno total ou ajuste a conta à mão.

Conta: 3f1c...
Evento: estorno parcial
Pagamento: pay_... · vencimento 2026-11-16 · R$ 89.90
Assinatura do pagamento: nenhuma (pagamento avulso, ex.: anual)
Antes: PRO_YEARLY ACTIVE, pago até 2027-11-16
```

Na maioria dos casos não há nada a fazer. Quem faz um estorno parcial é sempre você, pelo painel do Asaas (o usuário não consegue pedir sozinho), e em geral é um desconto ou uma compensação: por exemplo, devolver R$ 10 por um problema. A pessoa continua pagante, e a API não tem como saber outra intenção, então mantém o Pro e só avisa.

Você só precisa agir se o estorno parcial era para **encerrar o Pro**. O caso típico é o usuário que cancela o anual no meio e recebe de volta a parte que não usou. Duas saídas:

- **Estorno total em vez de parcial**, quando faz sentido devolver tudo: a API encerra o Pro sozinha.
- **Ajuste à mão**: [encerrar o Pro agora](#encerrar-o-pro-agora).

### Exemplo: chargeback ganho

Depois do `chargeback aberto · Pro descontado` (com "Antes: PRO_MONTHLY ACTIVE, pago até 2026-12-15" e "Depois: PRO_MONTHLY CANCELED, pago até 2026-11-15"), chega o `chargeback ganho · Pro sem mudança`. O dinheiro vai voltar para você, mas a conta continua sem Pro. Se quiser devolver o que o usuário tinha pago, use a data do "Antes" do e-mail do chargeback aberto em [devolver o Pro até uma data](#devolver-o-pro-até-uma-data). Na mensal, a assinatura do Asaas foi cancelada no chargeback: o usuário assina de novo pelo app quando o Pro acabar.

### Ajustar a assinatura à mão

Não há tela nem script de administração para isso: o ajuste é direto no DynamoDB de prod. A assinatura é gravada com `version` (escrita condicional): todo ajuste lê o `version` e grava `version + 1` com a condição de que ele não mudou. Assim o ajuste não apaga uma escrita do webhook que chegou no meio, nem é apagado por ela.

**1. Ler a assinatura**:

```bash
aws dynamodb get-item --table-name "$MAIN_TABLE" --key "$KEY" --consistent-read \
  --query 'Item.{status:status.S,planId:planId.S,paidUntil:paidUntil.S,version:version.N,assinatura:gatewayRefs.M.subscriptionId.S}'
```

Anote o `version`. Se vier `null` (assinatura gravada antes de existir o campo), troque nos comandos abaixo a condição `'#version = :read'` por `'attribute_not_exists(#version)'`, tire o `:read` dos valores e use `:next` = `1`.

**Mensal com assinatura do Asaas ativa**: cancele a assinatura no painel do Asaas **antes** do ajuste. Sem isso, a próxima cobrança dela pode devolver o Pro.

#### Encerrar o Pro agora

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
VERSION=3  # o version lido no passo 1
aws dynamodb update-item --table-name "$MAIN_TABLE" --key "$KEY" \
  --update-expression 'SET #status = :canceled, paidUntil = :now, canceledAt = :now, #version = :next' \
  --condition-expression '#version = :read' \
  --expression-attribute-names '{"#status":"status","#version":"version"}' \
  --expression-attribute-values "{\":canceled\":{\"S\":\"CANCELED\"},\":now\":{\"S\":\"$NOW\"},\":read\":{\"N\":\"$VERSION\"},\":next\":{\"N\":\"$((VERSION + 1))\"}}"
```

`CANCELED` com `paidUntil` = agora tira o Pro na hora (o `CANCELED` não tem os 3 dias de carência). No app, a conta aparece como expirada em Planos e pode assinar de novo.

#### Devolver o Pro até uma data

```bash
VERSION=3                         # o version lido no passo 1
UNTIL=2026-12-15T00:00:00.000Z    # a data até quando o Pro vale
STATUS=CANCELED                   # mensal (a assinatura do Asaas já foi cancelada); no anual, ACTIVE
aws dynamodb update-item --table-name "$MAIN_TABLE" --key "$KEY" \
  --update-expression 'SET #status = :status, paidUntil = :until, #version = :next' \
  --condition-expression '#version = :read' \
  --expression-attribute-names '{"#status":"status","#version":"version"}' \
  --expression-attribute-values "{\":status\":{\"S\":\"$STATUS\"},\":until\":{\"S\":\"$UNTIL\"},\":read\":{\"N\":\"$VERSION\"},\":next\":{\"N\":\"$((VERSION + 1))\"}}"
```

Se o comando falhar com `ConditionalCheckFailedException`, outra escrita mudou a assinatura depois da leitura: leia de novo (passo 1), confira se o ajuste ainda faz sentido e repita com o `version` novo.

## Pagamento de outra assinatura com o Pro ativo

Chega quando um pagamento confirmado não é da assinatura mensal guardada e ela ainda dá Pro, ou quando uma assinatura do Asaas cobra com o anual pago no futuro. A conta pode estar com **duas cobranças ativas** no Asaas (por exemplo, dois checkouts criados no mesmo instante).

O que fazer:

1. No painel do Asaas, abra o cliente da conta e veja as assinaturas ativas.
2. Cancele a que sobrou e estorne a cobrança em dobro, se houver. O estorno gera um e-mail de [estorno](#estorno-e-chargeback), que deve dizer "Pro sem mudança" (a API não tira o Pro de quem pagou pela outra assinatura).

Exemplo: "Situação guardada antes do pagamento: assinatura mensal sub_A (ACTIVE)" e "Assinatura do pagamento: sub_B". A API passou a guardar a `sub_B` e lembra da `sub_A` em `replacedSubscriptionId`. Cancele uma das duas no painel e estorne o pagamento dela.

## Reconciliação encontrou divergências

A reconciliação horária (só em prod) achou algo que o webhook não fez. O e-mail traz quatro listas; o detalhe está em [reconciliação](../fluxos/billing-reconciliacao.md#o-e-mail-de-alerta).

| Lista | O que fazer |
|---|---|
| Ativados pela reconciliação | Ver nos logs da `webhookAsaas` e nos webhooks do painel do Asaas (histórico de envios) por que o webhook não ativou |
| Estornos ou chargebacks aplicados pela reconciliação | O mesmo, para o evento de estorno. A conta já foi ajustada |
| Pagos ou estornados sem conta correspondente | Achar o cliente no painel do Asaas e ligar o pagamento à conta à mão |
| Com erro | Nada: são tentados de novo na próxima hora. Se repetir, ver os logs da `reconcilePayments` |

## Alarmes do CloudWatch

Só ligados em prod. O assunto é `ALARM: "nacal-api-prod-<alarme>" in South America (Sao Paulo)`.

| Alarme | Significa | O que fazer |
|---|---|---|
| `MealsDLQAlarm` | Uma refeição esgotou as 3 entregas sem conseguir nem marcar `FAILED` | Ver os logs da `processMeal` pelo `mealId` da mensagem (linhas `sqs message failed`, com o `messageId`). A refeição pode ter ficado presa sem estorno de cota |
| `MealsQueueAgeAlarm` | A mensagem mais antiga da fila de refeições passou de 2 min | Ver erros e throttling da `processMeal` e se a OpenAI está fora |
| `MealUploadCheckDLQAlarm` | A checagem de 15 min de uma refeição falhou 3 vezes | Ver os logs da `checkMealUpload` e conferir a refeição e a cota à mão |
| `ReconcilePaymentsErrorsAlarm` | A Lambda da reconciliação deu erro | Ver os logs da `reconcilePayments`. Ela roda de novo na hora seguinte |
| `HttpApi5xxAlarm` | 3 ou mais respostas `5xx` do HTTP API em 5 min | Ver [abaixo](#httpapi5xxalarm) |
| `AsaasWebhookNon2xxAlarm` | O webhook do Asaas respondeu algo diferente de 2xx | Ver [abaixo](#asaaswebhooknon2xxalarm) |
| `MealFailedAlarm` | Uma ou mais refeições viraram `FAILED` em 15 min | Ver [abaixo](#mealfailedalarm) |
| `NewMealUploadedTriggerErrorsAlarm` | A Lambda que enfileira o upload da refeição deu erro | Ver [abaixo](#newmealuploadedtriggererrorsalarm) |
| `ProcessMealThrottlesAlarm` | A `processMeal` foi recusada por limite de concorrência | Ver [abaixo](#processmealthrottlesalarm) |

Para ver os logs:

```bash
AWS_PROFILE=nacal-prod sls logs -f processMeal --stage prod --startTime 1h
```

Quando o problema estiver resolvido, as mensagens que sobraram na DLQ podem ser reprocessadas pelo console do SQS (`Start DLQ redrive`) ou apagadas.

Os logs são JSON (ver [operação](../06-operacao.md#logs)). As consultas abaixo rodam no CloudWatch Logs Insights, no log group indicado, em `sa-east-1`. Pelo terminal:

```bash
QUERY_ID=$(aws logs start-query --log-group-name /aws/lambda/nacal-api-prod-<função> \
  --start-time $(( $(date +%s) - 3600 )) --end-time $(date +%s) \
  --query-string '<consulta>' --query queryId --output text)
sleep 5; aws logs get-query-results --query-id "$QUERY_ID"
```

### HttpApi5xxAlarm

Soma de respostas `5xx` do HTTP API (métrica `5xx` do API Gateway) chegou a 3 em 5 min. Entram os `500` de erro não tratado, os `502 BILLING_ERROR` (Asaas fora ou lento) e `CODE_DELIVERY_FAILED`, o `500` do webhook depois de 3 conflitos de escrita na assinatura, o `500` do `refresh-token` com erro do Cognito que não é recusa nem throttling, e o `503`/`504` de uma Lambda que estourou o timeout.

O que fazer: achar a rota e o erro. Como o alarme é do API Gateway, comece pelo access log (`/aws/http-api/nacal-api-prod`), que mostra a rota mesmo quando a Lambda não respondeu:

```text
fields @timestamp, routeKey, status
| filter status like /^5/
| stats count() by routeKey, status
```

Depois, no log group da função da rota, a linha `http request` traz o `error` com a stack:

```text
fields @timestamp, statusCode, errorCode, error.name, error.message, accountId
| filter message = "http request" and statusCode >= 500
| sort @timestamp desc
```

Exemplo: `ALARM: "nacal-api-prod-HttpApi5xxAlarm"` com 4 `502` em `POST /billing/checkout`, todos `BILLING_ERROR` com `error.message` "Asaas request timed out or failed.": o Asaas estava fora. Conferir a página de status do Asaas e esperar; o usuário pode tentar de novo.

### AsaasWebhookNon2xxAlarm

O código do webhook do Asaas respondeu algo diferente de 2xx ao menos uma vez em 5 min (métrica EMF `WebhookNon2xx`, emitida pelo adapter HTTP). Falhas em que o código nem roda (throttle pelo `reservedConcurrency: 5`, timeout de 15 s, erro de init) não emitem a métrica; elas viram `5xx` do API Gateway e só entram no `HttpApi5xxAlarm` (a partir de 3 em 5 min). Um `403` de alguém sondando a URL também dispara este alarme. O Asaas reenvia o evento, mas **pausa a fila do webhook depois de 15 falhas seguidas**, e aí nada mais chega (a reconciliação horária cobre pagamentos e estornos, mas não o resto).

| `statusCode` / `errorCode` | Causa provável | O que fazer |
|---|---|---|
| `403 FORBIDDEN` | IP fora da `ASAAS_WEBHOOK_ALLOWED_IPS` | Se o IP for de um envio real do Asaas (conferir no histórico de envios do painel), o Asaas mudou os IPs: atualizar a allowlist no `.env.prod` e fazer deploy. Se não, é alguém sondando a URL: nada a fazer |
| `502 BILLING_ERROR` | `error.message` "Invalid webhook token.": token do header diferente do `ASAAS_WEBHOOK_TOKEN`. Outra mensagem: o Asaas falhou numa consulta feita durante o evento | Conferir o token configurado no webhook do painel contra o `.env.prod`. Falha do Asaas se resolve no reenvio |
| `500 INTERNAL_SERVER_ERROR` | 3 conflitos de escrita na assinatura ou erro não tratado | Ver o `error` na linha `http request`. Conflito se resolve no reenvio do Asaas |
| `429 RATE_LIMIT_EXCEEDED` | Mais de 120 chamadas por minuto do mesmo IP | Rajada de reenvios; normalmente se resolve sozinho |

Consulta no log group `/aws/lambda/nacal-api-prod-webhookAsaas`:

```text
fields @timestamp, statusCode, errorCode, error.message
| filter message = "http request" and (statusCode < 200 or statusCode >= 300)
| sort @timestamp desc
```

Depois de corrigir, conferir no painel do Asaas (Integrações → Webhooks) se a fila está ativa e reativar se estiver pausada; os eventos pendentes são reenviados.

Exemplo: `ALARM: "nacal-api-prod-AsaasWebhookNon2xxAlarm"`, e a consulta mostra três `403 FORBIDDEN` de um IP que aparece no histórico de envios do Asaas: o Asaas passou a usar um IP novo. Atualizar `ASAAS_WEBHOOK_ALLOWED_IPS` e fazer deploy.

### MealFailedAlarm

Uma ou mais refeições viraram `FAILED` em 15 min (métrica EMF `MealFailed`). Cada uma já teve a cota estornada e o arquivo apagado, e o app mostrou o erro ao usuário. O alarme existe para o estorno não esconder um problema sistêmico. O campo `source` diz o caminho:

| `source` | Significa |
|---|---|
| `attemptsExhausted` | As 2 tentativas deram erro (OpenAI fora, resposta cortada, timeout) |
| `leaseExpired` | A Lambda morreu na 2ª tentativa e a 3ª entrega só marcou `FAILED` |
| `uploadStalled` | Upload que nunca chegou ou refeição que ninguém pegou em 15 min (checagem do `checkMealUpload`) |

Consulta no log group `/aws/lambda/nacal-api-prod-processMeal` (e no da `checkMealUpload`, para `uploadStalled`):

```text
fields @timestamp, mealId, accountId, source
| filter message = "metric MealFailed"
| sort @timestamp desc
```

Para ver o erro de cada tentativa de uma refeição:

```text
fields @timestamp, message, attempt, error.message, error.cause.message
| filter mealId = "<mealId>"
| sort @timestamp asc
```

Exemplo: 3 `MealFailed` com `source: attemptsExhausted` e `error.message` "[OPEN AI] ... Request timed out." em todas: a OpenAI estava lenta ou fora. Conferir a página de status da OpenAI. Uma falha isolada com `uploadStalled` costuma ser o app fechado no meio do upload e não precisa de ação. A métrica conta eventos: a mesma refeição pode aparecer duas vezes se a mensagem for reentregue.

### ProcessMealThrottlesAlarm

A Lambda `processMeal` foi recusada por falta de concorrência (métrica `Throttles`). As mensagens ficam na fila e são reentregues, então nada se perde de imediato, mas a refeição atrasa e o `MealsQueueAgeAlarm` deve vir junto.

O que fazer: ver a concorrência da conta (`aws lambda get-account-settings`, a cota de prod é 1000) e se alguma função está consumindo tudo (métrica `ConcurrentExecutions` por função no CloudWatch). Se for rajada de refeições, considerar `maximumConcurrency` no evento SQS da `processMeal` (P17).

### NewMealUploadedTriggerErrorsAlarm

A `newMealUploadedTrigger` (evento `ObjectCreated` do S3) deu erro. Ela lê os metadados do arquivo, marca a refeição como `QUEUED` e publica na `MealsQueue`. O S3 repete o evento até 2 vezes (cerca de 1 e 2 minutos depois), então uma falha passageira costuma se resolver sozinha, mas a métrica `Errors` conta cada tentativa que falhou. Se as 3 falharem, o evento se perde: não há fila de falhas, e a refeição fica em `UPLOADING` (ou em `QUEUED` sem mensagem) até a checagem de 15 min marcar `FAILED` e estornar a cota. O `MealFailedAlarm` (`source: uploadStalled`) vem depois.

Consulta no log group `/aws/lambda/nacal-api-prod-newMealUploadedTrigger`:

```text
fields @timestamp, fileKey, error.name, error.message
| filter message = "s3 event failed"
| sort @timestamp desc
```

O `fileKey` tem o formato `<accountId>/<uuid>.<ext>`. Causas possíveis: arquivo inexistente no `HeadObject` (aparece como `error.name: Unknown`, porque o `HEAD` não traz corpo de erro; não é esperado, já que a exclusão da refeição só acontece depois do processamento, então confira se alguém apagou o objeto à mão), `Cannot get metadata file` (objeto sem os metadados `mealid` e `accountid`, que não vem do app) e erro do DynamoDB ou do SQS (ver o status da AWS e o `error.message`). Refeição inexistente ou arquivo diferente do `inputFileKey` não dão erro: aparecem como `warn` (`uploaded file has no meal`, `uploaded file does not match meal input file`).

Exemplo: `ALARM: "nacal-api-prod-NewMealUploadedTriggerErrorsAlarm"` e três linhas `s3 event failed` com `ThrottlingException` do DynamoDB: a tabela estava limitada; o evento foi repetido e as refeições seguiram. Uma falha única que não se repete nas tentativas seguintes costuma ser passageira e não pede ação; 3 linhas para o mesmo `fileKey` pedem investigação, porque a refeição vai virar `FAILED` e ser estornada.

## GuardDuty

Os findings de severidade média para cima vão para o mesmo tópico. A regra foi criada à mão em prod, fora do `serverless.yml`. Abra o finding no console do GuardDuty, veja o recurso e a ação suspeita e trate como incidente de segurança se não reconhecer a atividade.
