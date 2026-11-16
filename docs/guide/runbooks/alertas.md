# Runbook: alertas por e-mail

Escopo: o que significa cada e-mail de alerta da API e o que fazer com ele. Todos chegam pelo tópico SNS `DQLAlarmTopic` (o nome é esse mesmo, com `DQL`), que manda e-mail para `DLQ_ALARM_EMAIL`.

| Assunto do e-mail | Quem manda | Seção |
|---|---|---|
| `NaCal: estorno total · Pro descontado`, `NaCal: estorno parcial · Pro sem mudança`, `NaCal: chargeback aberto · ...` etc. | Webhook do Asaas | [Estorno e chargeback](#estorno-e-chargeback) |
| `NaCal: pagamento de outra assinatura com o Pro ativo` | Webhook do Asaas | [Pagamento de outra assinatura com o Pro ativo](#pagamento-de-outra-assinatura-com-o-pro-ativo) |
| `NaCal: reconciliação de pagamentos encontrou divergências` | Reconciliação horária | [Reconciliação encontrou divergências](#reconciliação-encontrou-divergências) |
| `ALARM: "nacal-api-prod-..."` | CloudWatch | [Alarmes do CloudWatch](#alarmes-do-cloudwatch) |
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
| `MealsDLQAlarm` | Uma refeição esgotou as 3 entregas sem conseguir nem marcar `FAILED` | Ver os logs da `processMeal` pelo `mealId` da mensagem (`SQS message <id> failed:`). A refeição pode ter ficado presa sem estorno de cota |
| `MealsQueueAgeAlarm` | A mensagem mais antiga da fila de refeições passou de 2 min | Ver erros e throttling da `processMeal` e se a OpenAI está fora |
| `MealUploadCheckDLQAlarm` | A checagem de 15 min de uma refeição falhou 3 vezes | Ver os logs da `checkMealUpload` e conferir a refeição e a cota à mão |
| `ReconcilePaymentsErrorsAlarm` | A Lambda da reconciliação deu erro | Ver os logs da `reconcilePayments`. Ela roda de novo na hora seguinte |

Para ver os logs:

```bash
AWS_PROFILE=nacal-prod sls logs -f processMeal --stage prod --startTime 1h
```

Quando o problema estiver resolvido, as mensagens que sobraram na DLQ podem ser reprocessadas pelo console do SQS (`Start DLQ redrive`) ou apagadas.

## GuardDuty

Os findings de severidade média para cima vão para o mesmo tópico. A regra foi criada à mão em prod, fora do `serverless.yml`. Abra o finding no console do GuardDuty, veja o recurso e a ação suspeita e trate como incidente de segurança se não reconhecer a atividade.
