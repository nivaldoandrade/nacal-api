# Runbook: exclusão manual de conta (beta)

Escopo: exclusão manual de uma conta no stage `prod` durante o beta. O app ainda não tem autoatendimento de exclusão; este runbook é operado por suporte/engenharia. Para exclusão de dados sem apagar a conta, ou para dúvidas de retenção legal, envolva o jurídico antes de executar.

## Antes de começar

- O e-mail aberto pelo app (Perfil → Excluir conta) já traz no corpo "E-mail da conta: …", que é o e-mail cadastrado. Se o remetente for esse mesmo e-mail, siga. Se for outro (o app de e-mail do celular pode estar em outra conta, comum com login pelo Google), **escreva para o e-mail cadastrado** pedindo que confirme o pedido e só execute depois da resposta. Não aceite pedido de terceiro.
- Registre no ticket: data, e-mail, identificador do pedido e operador.
- **Responda ao pedido antes de executar**, sempre para o e-mail cadastrado da conta (o "E-mail da conta" do corpo), mesmo quando o remetente for o próprio. Até a execução a conta segue funcionando normalmente, e o titular pode desistir; depois de executada não há volta (não restaure pelo PITR). O prazo prometido é de até 15 dias, mas a ideia é executar em 1 ou 2 dias. Modelo:

  > Assunto: Exclusão da sua conta no NaCal
  >
  > Olá! Recebemos seu pedido para excluir a conta do NaCal ligada a este e-mail.
  >
  > Vamos excluir sua conta e todos os seus dados (perfil, metas, refeições, fotos e áudios) em [data]. Depois disso não será possível recuperar nada. Se você tiver uma assinatura ativa, ela será cancelada antes e não haverá novas cobranças.
  >
  > Mudou de ideia? É só responder este e-mail até [data] e mantemos sua conta como está.
  >
  > Se você não fez esse pedido, responda este e-mail para avisarmos e não excluirmos nada.
  >
  > Equipe NaCal

  Quando o remetente for outro e-mail, só execute depois que o titular confirmar respondendo a esta mensagem. Depois de executar, envie uma confirmação curta de que a exclusão foi concluída.
- Tenha acesso ao AWS CLI com permissão em Cognito, DynamoDB e S3, e ao painel do Asaas. Em prod, rode com `export AWS_PROFILE=nacal-prod`.
- Nunca execute `sls remove` para atender uma exclusão: isso remove o ambiente inteiro.
- Se a conta tiver assinatura ativa, cancele a assinatura antes de apagar os dados. Se o cancelamento falhar, pare e escale.

## 1. Definir variáveis e localizar a conta

```bash
export AWS_PROFILE=nacal-prod
test "$(aws iam list-account-aliases --query 'AccountAliases[0]' --output text)" = "nacal-prod" && echo "conta de prod: ok" || echo "PARE: não é a conta de prod"
export AWS_REGION=sa-east-1
export STAGE=prod
export MAIN_TABLE="nacal-api-${STAGE}-MainTable"
export RATE_LIMIT_TABLE="nacal-api-${STAGE}-RateLimitTable"
export MEALS_BUCKET="nacal-api-${STAGE}-meals-bucket"
export EMAIL="pessoa@exemplo.com"  # sempre em minúsculas, como a API normaliza

ACCOUNT_ID=$(aws dynamodb query \
  --region "$AWS_REGION" \
  --table-name "$MAIN_TABLE" \
  --index-name GSI1 \
  --key-condition-expression 'GSI1PK = :pk AND GSI1SK = :sk' \
  --expression-attribute-values "{\":pk\":{\"S\":\"ACCOUNT#${EMAIL}\"},\":sk\":{\"S\":\"ACCOUNT#${EMAIL}\"}}" \
  --query 'Items[0].id.S' \
  --output text)

test -n "$ACCOUNT_ID" && test "$ACCOUNT_ID" != "None" && echo "accountId=$ACCOUNT_ID"
```

Se aparecer "PARE: não é a conta de prod", não continue: sem o `AWS_PROFILE` a CLI usa o perfil `default` (a conta de dev) e os comandos de apagar iriam para a conta errada; rode `aws sso login --sso-session nacal` se a sessão tiver expirado. Se `ACCOUNT_ID` ficar vazio, não continue. Confira o e-mail e se a conta existe. Todos os comandos abaixo precisam rodar na mesma janela do terminal, por causa das variáveis.

## 2. Verificar e cancelar a assinatura

```bash
aws dynamodb get-item \
  --region "$AWS_REGION" \
  --table-name "$MAIN_TABLE" \
  --key "{\"PK\":{\"S\":\"ACCOUNT#${ACCOUNT_ID}\"},\"SK\":{\"S\":\"ACCOUNT#${ACCOUNT_ID}#SUBSCRIPTION\"}}" \
  --output json
```

- `TRIALING`: trial sem cobrança; não há assinatura paga a cancelar.
- `ACTIVE` ou `PAST_DUE`: cancele a assinatura no painel do Asaas usando o `gatewayRefs.subscriptionId`. Não apague o cliente nem o histórico financeiro do Asaas.
- `CANCELED` ou `EXPIRED`: não há cobrança futura; siga adiante.
- Se não existir item de assinatura, siga adiante.

## 3. Remover os arquivos de refeição

```bash
aws s3 rm "s3://${MEALS_BUCKET}/${ACCOUNT_ID}/" --recursive
```

Não há CDN na frente do bucket (removida em 2026-11-17), então não há cache a invalidar: depois do `s3 rm` os arquivos não podem mais ser lidos.

## 4. Listar e apagar os itens da `MainTable`

Itens da conta: perfil, metas, assinatura, refeições (`ACCOUNT#<id>`), cadastro pendente (`PENDING_SIGNUP#<id>`), checkout aberto (`PENDING_CHECKOUT#<id>`, que o TTL apaga em até 60 min) e vínculos de checkout (`GATEWAY#<checkoutId>`, que guardam o `accountId` num atributo).

```bash
cat > /tmp/nacal-delete-main.json <<EOF
{
  ":account": {"S": "ACCOUNT#${ACCOUNT_ID}"},
  ":pending": {"S": "PENDING_SIGNUP#${ACCOUNT_ID}"},
  ":checkout": {"S": "PENDING_CHECKOUT#${ACCOUNT_ID}"},
  ":gateway": {"S": "GATEWAY#"},
  ":accountId": {"S": "${ACCOUNT_ID}"}
}
EOF
export MAIN_FILTER='begins_with(PK, :account) OR begins_with(PK, :pending) OR begins_with(PK, :checkout) OR (begins_with(PK, :gateway) AND accountId = :accountId)'
```

Liste primeiro, sem apagar:

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$MAIN_TABLE" \
  --filter-expression "$MAIN_FILTER" \
  --expression-attribute-values file:///tmp/nacal-delete-main.json \
  --projection-expression 'PK, SK, #type, #status' \
  --expression-attribute-names '{"#status":"status","#type":"type"}' \
  --output table
```

Confira que os itens listados pertencem ao `ACCOUNT_ID` correto. Depois, apague:

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$MAIN_TABLE" \
  --filter-expression "$MAIN_FILTER" \
  --expression-attribute-values file:///tmp/nacal-delete-main.json \
  --projection-expression 'PK, SK' \
  --query 'Items[].[PK.S,SK.S]' \
  --output text |
while IFS=$'\t' read -r PK SK; do
  if [ -n "$PK" ]; then
    aws dynamodb delete-item \
      --region "$AWS_REGION" \
      --table-name "$MAIN_TABLE" \
      --key "{\"PK\":{\"S\":\"$PK\"},\"SK\":{\"S\":\"$SK\"}}"
  fi
done
```

## 4b. Listar e apagar os contadores da `RateLimitTable`

Os contadores de cota e de rate limit ficam na `RateLimitTable`, não na `MainTable` (formato das chaves em [modelo de dados](../03-modelo-de-dados.md#collections-da-ratelimittable)):

- cotas: `RL#account-monthly#<id>` e `RL#account-daily#<id>` (só no Pro);
- rate limit por conta: `RL#account#<rota>#<id>`;
- rate limit por e-mail: `RL#email#<rota>#email#<email>`, com o **e-mail no próprio PK**.

Como a rota fica no meio da chave, o filtro usa `contains`, não `begins_with`. Todos têm `expiresAt` (TTL), mas apague agora para não deixar o e-mail guardado até o TTL.

```bash
cat > /tmp/nacal-delete-rl.json <<EOF
{
  ":accountId": {"S": "#${ACCOUNT_ID}"},
  ":emailKey": {"S": "#email#${EMAIL}"}
}
EOF
export RL_FILTER='contains(PK, :accountId) OR contains(PK, :emailKey)'

aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$RATE_LIMIT_TABLE" \
  --filter-expression "$RL_FILTER" \
  --expression-attribute-values file:///tmp/nacal-delete-rl.json \
  --projection-expression 'PK, SK' \
  --output table
```

Confira a lista e apague:

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$RATE_LIMIT_TABLE" \
  --filter-expression "$RL_FILTER" \
  --expression-attribute-values file:///tmp/nacal-delete-rl.json \
  --projection-expression 'PK, SK' \
  --query 'Items[].[PK.S,SK.S]' \
  --output text |
while IFS=$'\t' read -r PK SK; do
  if [ -n "$PK" ]; then
    aws dynamodb delete-item \
      --region "$AWS_REGION" \
      --table-name "$RATE_LIMIT_TABLE" \
      --key "{\"PK\":{\"S\":\"$PK\"},\"SK\":{\"S\":\"$SK\"}}"
  fi
done
```

Chaves `RL#ip#...` e `RL#webhook-event#...` não são vinculadas à conta; elas expiram pelo TTL. Não apague itens de outras contas.

## 5. Apagar o usuário do Cognito

```bash
USER_POOL_ID=$(aws cloudformation describe-stack-resources \
  --region "$AWS_REGION" \
  --stack-name "nacal-api-${STAGE}" \
  --logical-resource-id UserPool \
  --query 'StackResources[0].PhysicalResourceId' \
  --output text)

aws cognito-idp admin-delete-user \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL"
```

## 6. Verificar

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$MAIN_TABLE" \
  --filter-expression "$MAIN_FILTER" \
  --expression-attribute-values file:///tmp/nacal-delete-main.json \
  --select COUNT \
  --query 'Count'

aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$RATE_LIMIT_TABLE" \
  --filter-expression "$RL_FILTER" \
  --expression-attribute-values file:///tmp/nacal-delete-rl.json \
  --select COUNT \
  --query 'Count'

aws s3 ls "s3://${MEALS_BUCKET}/${ACCOUNT_ID}/"

aws cognito-idp admin-get-user \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL"
```

Esperado: as duas contagens `0`, listagem do S3 vazia e `UserNotFoundException` no Cognito. Registre as evidências no ticket e confirme ao titular pelo canal oficial.

## Retenção e limpeza

- DynamoDB tem point-in-time recovery de 35 dias; itens excluídos podem permanecer nos backups até expirarem. Não restaure a conta para “completar” a exclusão.
- O bucket de refeições não tem versionamento nem CDN; após o `s3 rm` os objetos deixam de existir.
- Logs operacionais podem conter e-mail ou `accountId`; aplique a retenção mínima e restrinja o acesso.
- O Asaas pode reter dados financeiros por obrigação legal/fiscal. Cancele a assinatura, mas não prometa ao titular a eliminação desses registros sem validação jurídica.
- Apague `/tmp/nacal-delete-main.json` e `/tmp/nacal-delete-rl.json` ao terminar.
