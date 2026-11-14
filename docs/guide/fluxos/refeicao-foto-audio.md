# Fluxo: refeição por foto ou áudio

## Resumo

O app pede à API uma autorização de upload, manda o arquivo **direto para o S3** e fica consultando a refeição até ela terminar. O upload dispara uma fila, e uma Lambda valida o arquivo, passa a foto pelo gate da Cloudflare, manda o conteúdo para a OpenAI e grava os alimentos. A cota é consumida **no início**. Se a refeição não chegar a `SUCCESS` (rejeitada, falhou ou travou), a cota é **devolvida**.

| | |
|---|---|
| **Entrada** | `POST /create-meal` 🔒 |
| **Acompanhamento** | `GET /meals/{id}` 🔒, polling a cada 3 s enquanto o status está em andamento |
| **Lambdas** | `createMeal` → `newMealUploadedTrigger` → `processMeal` (+ `checkMealUpload` após 15 min) |
| **Tipos aceitos** | `image/jpeg` (até 10 MB) · `audio/m4a` e `audio/webm` (até 2 MB, de 1 a 32 s) |
| **Rate limit** | 10 criações por hora por conta |

## Visão de ponta a ponta

```mermaid
sequenceDiagram
    autonumber
    actor U as App
    participant C as API HTTP<br/>createMeal · getMealById
    participant Q as Cotas<br/>RateLimitTable
    participant DB as MainTable
    participant CQ as MealUploadCheckQueue
    participant S3 as S3 MealsBucket
    participant T as newMealUploadedTrigger
    participant MQ as MealsQueue
    participant P as processMeal
    participant CF as Cloudflare gate
    participant AI as OpenAI

    rect rgba(100, 150, 255, 0.08)
    Note over U,CQ: 1 · Criação: síncrona, dentro da request
    U->>C: POST /create-meal com contentType, fileSize, timeZone e description
    C->>Q: consome a cota, de forma atômica
    alt sem cota
        Q-->>C: limite atingido
        C-->>U: 403 FREE_QUOTA_EXCEEDED ou 429 DAILY_MEAL_LIMIT_REACHED
    end
    C->>C: gera o Presigned POST, válido por 5 min
    C->>CQ: publica a checagem, com atraso de 15 min
    C->>DB: cria a refeição com status UPLOADING
    C-->>U: 201 com mealId e uploadSignature
    end

    rect rgba(100, 200, 120, 0.08)
    Note over U,MQ: 2 · Upload: o app fala direto com o S3
    U->>S3: POST multipart com o arquivo e os metadados mealid e accountid
    S3-)T: evento ObjectCreated
    T->>S3: HeadObject para ler mealid e accountid
    T->>DB: status QUEUED, só se estava UPLOADING ou QUEUED
    T->>MQ: publica accountId e mealId
    end

    loop a cada 3 s enquanto UPLOADING, QUEUED ou PROCESSING
        U->>C: GET /meals/{id}, leitura consistente
    end

    rect rgba(255, 170, 60, 0.08)
    Note over MQ,AI: 3 · Processamento: assíncrono, com retry
    MQ-)P: entrega a mensagem
    P->>DB: reivindica a refeição: PROCESSING, lease de 130 s, attempts + 1
    P->>S3: baixa o arquivo
    P->>P: valida magic bytes, tamanho e duração
    opt é foto
        P->>CF: tem comida ou bebida?
        CF-->>P: score de 0 a 1, abaixo de 0.30 rejeita
    end
    alt é foto
        P->>AI: gpt-5.4-mini com a URL da CDN e a description
    else é áudio
        P->>AI: gpt-4o-transcribe
        P->>AI: gpt-5.4-mini com a transcrição
    end
    AI-->>P: alimentos, mealType e unidentified
    P->>P: calcula as calorias, define nome e ícone, limita a 30 itens
    P->>DB: SUCCESS, só se ainda estiver PROCESSING
    end

    U->>C: GET /meals/{id}
    C-->>U: refeição com status SUCCESS e alimentos
```

## Estados da refeição

```mermaid
stateDiagram-v2
    [*] --> UPLOADING: POST /create-meal<br/>cota consumida

    UPLOADING --> QUEUED: arquivo chegou no S3<br/>newMealUploadedTrigger
    UPLOADING --> FAILED: 15 min sem upload<br/>checkMealUpload · estorna

    QUEUED --> PROCESSING: processMeal reivindica<br/>attempts + 1, lease 130 s
    QUEUED --> FAILED: 15 min sem ninguém pegar<br/>checkMealUpload · estorna

    PROCESSING --> SUCCESS: IA devolveu alimentos
    PROCESSING --> REJECTED: arquivo inválido, gate ou sem comida<br/>estorna
    PROCESSING --> QUEUED: erro transitório na 1ª tentativa<br/>SQS entrega de novo
    PROCESSING --> FAILED: erro na 2ª tentativa<br/>estorna

    SUCCESS --> DELETED: DELETE /meals/{id}
    REJECTED --> DELETED: DELETE /meals/{id}
    FAILED --> DELETED: DELETE /meals/{id}

    SUCCESS --> [*]
    DELETED --> [*]
```

| Status | Significado | O app mostra | Cota |
|---|---|---|---|
| `UPLOADING` | Refeição criada, esperando o arquivo chegar ao S3 | "Processando" | Consumida |
| `QUEUED` | Arquivo no S3, mensagem na fila | "Processando" | Consumida |
| `PROCESSING` | Uma Lambda está processando, com lease | "Processando" | Consumida |
| `SUCCESS` | Alimentos gravados | A refeição | Consumida |
| `REJECTED` | Não é refeição, arquivo inválido ou sem alimentos (`rejectionReason`) | Mensagem conforme o motivo | **Estornada** |
| `FAILED` | Erro técnico ou upload que travou | Mensagem de erro | **Estornada** |
| `DELETED` | Excluída pelo usuário (some das listagens) | Nada | Não volta |

Uma refeição `SUCCESS` excluída **não devolve** a cota: a IA já foi usada.

## Decisões dentro do `processMeal`

```mermaid
flowchart TD
    msg(["Mensagem da MealsQueue"]) --> read["findById"]
    read --> notfound{"Existe?"}
    notfound -- "não" --> throwNF["lança erro<br/>→ retry → DLQ"]
    notfound -- "sim" --> terminal{"Status terminal?<br/>SUCCESS, REJECTED,<br/>FAILED ou DELETED"}
    terminal -- "sim" --> ack(["ignora<br/>mensagem duplicada"])
    terminal -- "não" --> uploading{"UPLOADING?"}
    uploading -- "sim" --> throwUp["lança erro<br/>leitura defasada, tenta de novo"]
    uploading -- "não" --> claim{"claimForProcessing<br/>QUEUED, ou PROCESSING com lease vencido,<br/>e attempts menor que 2"}

    claim -- "não conseguiu" --> exhausted{"attempts já é 2<br/>e QUEUED ou lease vencido?"}
    exhausted -- "sim" --> fail1["failAndRefund<br/>FAILED + estorno + apaga o arquivo"]
    exhausted -- "não" --> ack2(["ignora<br/>outra Lambda está processando"])

    claim -- "reivindicou" --> download["baixa o arquivo do S3"]
    download --> valid{"Arquivo válido?<br/>magic bytes, tamanho, duração"}
    valid -- "não" --> reject["rejectAndRefund<br/>REJECTED + estorno + apaga o arquivo"]
    valid -- "sim" --> isPic{"Foto?"}
    isPic -- "sim" --> gate{"Gate da Cloudflare"}
    gate -- "score menor que 0.30" --> reject
    gate -- "ACCEPT ou SKIP<br/>falha aberta" --> ai
    isPic -- "áudio" --> transcribe{"Transcrição vazia?"}
    transcribe -- "sim" --> reject
    transcribe -- "não" --> ai["OpenAI gpt-5.4-mini"]
    ai --> foods{"Sobrou algum alimento<br/>depois de remover<br/>os não identificados?"}
    foods -- "não" --> reject
    foods -- "sim" --> success["markSuccess<br/>só se ainda PROCESSING"]

    ai -- "erro: timeout, 5xx..." --> retry{"attempts maior<br/>ou igual a 2?"}
    download -- "erro" --> retry
    retry -- "não" --> requeue["markForRetry → QUEUED<br/>lança erro → SQS entrega de novo<br/>até 180 s depois do recebimento"]
    retry -- "sim" --> fail2["failAndRefund<br/>FAILED + estorno + apaga o arquivo"]
```

## Passo a passo

### 1. Criação (`POST /create-meal`)

1. O `@Schema(createMealSchema)` valida o corpo: `contentType` é um dos 3 MIME types, `fileSize` respeita o limite do tipo (10 MB para foto, 2 MB para áudio), `description` tem até 300 caracteres e **só é aceita para foto**.
2. O `CreateMealUseCase` descobre o plano efetivo (`Subscription.resolveEffectivePlan`) e **consome a cota** no `MealQuotaService` com um incremento condicional na `RateLimitTable`:
   - **Free**: contador mensal `RL#account-monthly#<accountId>` / `AAAA-MM`, limite 20.
   - **Pro**: contador diário no fuso de São Paulo, limite 20, mais um contador mensal com sufixo `#PRO` (sem limite, só para contar).
3. Gera a chave do arquivo (`<accountId>/<uuid>.<ext>`) e o **Presigned POST**, que só aceita aquele `Content-Type`, **exatamente** aquele `fileSize` e aquela chave. Os campos `x-amz-meta-mealid` e `x-amz-meta-accountid` são obrigatórios, mas a condição é `starts-with ''`: **o valor não é fixado**, e o trigger confia nele. Expira em 5 minutos.
4. Publica na `MealUploadCheckQueue` com `DelaySeconds: 900`. É a rede de segurança da [refeição presa](#refeição-presa-checagem-de-15-min).
5. Grava a refeição com `status: UPLOADING`, guardando `quotaMonth` e `quotaDay` para saber o que estornar depois.
6. Se qualquer passo de 3 a 5 falhar, a cota é estornada e a resposta é `500`.

Resposta `201`: `{ mealId, uploadSignature }`. O `uploadSignature` é o Presigned POST (URL + campos) em base64.

### 2. Upload e enfileiramento (`newMealUploadedTrigger`)

1. O app faz um `POST` multipart para o S3 com os campos do `uploadSignature` e o arquivo.
2. O S3 dispara `ObjectCreated`. A Lambda lê os metadados com `HeadObject`, porque a chave do arquivo não carrega o `mealId`.
3. `markQueued`: muda para `QUEUED` **só se** o status for `UPLOADING` ou `QUEUED`. Se a refeição já seguiu adiante, não faz nada.
4. Publica `{ accountId, mealId }` na `MealsQueue`.

Erros aqui só vão para o log (o adapter de S3 não lança). Se a publicação falhar, a refeição fica em `QUEUED` com `attempts = 0`, e a checagem de 15 minutos marca `FAILED` e estorna. Ela não reprocessa.

### 3. Processamento (`processMeal`)

**Reivindicação com lease.** `claimForProcessing` é um `UpdateItem` condicional: passa para `PROCESSING`, grava `leaseExpiresAt = agora + 130 s` e soma 1 em `attempts`, **só se** a refeição estiver `QUEUED` (ou `PROCESSING` com o lease vencido) e com `attempts < 2`. Isso impede duas Lambdas de processarem a mesma refeição quando o SQS entrega a mensagem duas vezes.

**Validação do arquivo** (`MealFileValidationService`): confere a assinatura real do arquivo (magic bytes), não a extensão. Para foto, JPEG de verdade (`FF D8 FF`), tamanho e dimensões (o app converte outros formatos para JPEG antes do upload). Para áudio, tamanho e duração de 1 a 32 s, lida com o `music-metadata`. O WebM gravado pelo Safari (iPhone e Mac) não traz a duração no cabeçalho, então ela é calculada pelo timecode do último bloco (`src/shared/utils/getWebmDurationSeconds.ts`). Arquivo inválido vira `REJECTED` com `INVALID_FILE`.

**Gate de foto** (`MealGateGateway`): manda a imagem ao modelo `clef-flash` da Cloudflare, com timeout de 8 s. Score abaixo de `MEAL_GATE_REJECT_THRESHOLD` (0.30) vira `REJECTED` com `NOT_A_MEAL`. **Falha aberta**: se o gate estiver desligado, sem credenciais, com a imagem grande demais (mais de 4 MB ou 16 MP), com erro HTTP, com resposta inválida ou com timeout, a decisão é `SKIP` e a foto segue para a OpenAI.

Configuração do gate: `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_AI_API_TOKEN` (token com permissão `Workers AI`), `MEAL_GATE_ENABLED` e `MEAL_GATE_REJECT_THRESHOLD`. Valor inválido em `MEAL_GATE_ENABLED` desliga o gate. Em `MEAL_GATE_REJECT_THRESHOLD`, volta para `0.30`. Os dois casos geram um aviso no log.

**IA** (`MealAiGateway`):

- **Foto**: o `gpt-5.4-mini` recebe a **URL da CDN** (a OpenAI baixa a imagem) e, se existir, a `description` dentro de `<user_note>`, com `<` e `>` neutralizados para a nota ser tratada como dado, não como instrução.
- **Áudio**: o arquivo é baixado pela CDN, transcrito pelo `gpt-4o-transcribe` e a transcrição vai para o `gpt-5.4-mini` com o prompt de texto (variante de áudio). Transcrição vazia vira `REJECTED` com `NO_FOOD_DETECTED`.
- A saída é estruturada (zod): alimentos com nome, quantidade e macros, o `mealType` declarado e o `unidentified`. Alimentos marcados como não identificados são removidos (log `[UNIDENTIFIED]`). Se não sobrar nenhum, vira `REJECTED` com `NO_FOOD_DETECTED`.

**Gravação**: calorias calculadas pela API (`4·carboidratos + 4·proteínas + 9·gorduras`), não pela IA. Nome e ícone vêm do `MealNamingService` (ver [nome e ícone](#nome-e-ícone-da-refeição)). No máximo 30 itens. `markSuccess` só grava se o status ainda for `PROCESSING`.

### Nome e ícone da refeição

A IA **não** escolhe o nome. A API usa o horário da criação no fuso do usuário (`timeZone` IANA enviado na criação; inválido ou ausente cai em `America/Sao_Paulo`). Quando o usuário **declara** a refeição ("almocei", "foi meu jantar") no áudio, no texto ou na descrição da foto, a IA devolve um `mealType`, que tem prioridade sobre o horário. Menção genérica ou negada vem `null`.

| Horário local | Nome | Ícone | `mealType` |
|---|---|---|---|
| 04:00–10:59 | Café da manhã | ☕ | `BREAKFAST` |
| 11:00–14:59 | Almoço | 🍽️ | `LUNCH` |
| 15:00–17:59 | Lanche da tarde | 🍎 | `AFTERNOON_SNACK` |
| 18:00–22:59 | Jantar | 🍲 | `DINNER` |
| 23:00–03:59 | Ceia | 🌙 | `SUPPER` |

O mesmo fuso define o **dia** da refeição no `GSI1PK`. Os dois cálculos usam `src/shared/utils/timeZone.ts`, então nome e dia nunca divergem. O mesmo vale para a refeição por texto.

### 4. Acompanhamento (`GET /meals/{id}`)

O app consulta a cada 3 s enquanto o status for `UPLOADING`, `QUEUED` ou `PROCESSING` (`app/src/app/hooks/queries/useGetMealById.ts`). A leitura é consistente (`ConsistentRead`), para não mostrar um status antigo.

## Retry, lease e estorno

O desenho junta três números que dependem uns dos outros:

```mermaid
gantt
    title Uma entrega da MealsQueue
    dateFormat ss
    axisFormat %M:%S
    section Lambda
    timeout do processMeal (120 s)        :a1, 00, 120s
    section DynamoDB
    lease da refeição (130 s)             :a2, 00, 130s
    section SQS
    visibility timeout (180 s)            :a3, 00, 180s
```

| Constante | Valor | Onde | Regra |
|---|---|---|---|
| Timeout do `processMeal` | 120 s | `sls/functions/meal.yml` | Menor que o lease |
| `Meal.PROCESSING_LEASE_SECONDS` | 130 s | `Meal.ts` | Maior que o timeout e menor que a visibilidade |
| `VisibilityTimeout` da `MealsQueue` | 180 s | `sls/resources/mealsQueue.yml` | Maior que o lease: quando a mensagem volta, o lease já venceu |
| `Meal.MAX_ATTEMPTS` | 2 | `Meal.ts` | Menor que o `maxReceiveCount` |
| `maxReceiveCount` | 3 | `mealsQueue.yml` | Sobra 1 entrega só para limpeza |
| `Meal.UPLOAD_CHECK_DELAY_SECONDS` | 900 s | `Meal.ts` | Máximo do SQS. Bem maior que os 5 min do Presigned POST |

**Por que três entregas para duas tentativas?** Se a Lambda morrer no meio da 2ª tentativa (timeout ou falta de memória), ninguém marca `FAILED`. A 3ª entrega encontra `attempts = 2` e o lease vencido e chama `failAndRefund`. Se a 3ª entrega também falhar, a mensagem vai para a `MealsDLQ` e, em prod, o alarme manda e-mail.

**Estorno atômico.** `failAndRefund` e `rejectAndRefund` usam uma `TransactWriteItems` que, juntos, mudam o status da refeição (condicionado ao status lido) e decrementam os contadores de cota (mês e, no Pro, dia), no bucket gravado na refeição, mesmo que o estorno aconteça no dia seguinte. O `ClientRequestToken` (`<mealId>#fail#<attempts>`, `<mealId>#reject#<attempts>` ou `<mealId>#upload` para a refeição presa em `UPLOADING`) torna a transação idempotente sem colidir com outra operação da mesma refeição. O DynamoDB aceita até 36 caracteres nesse token. A flag `quotaRefunded` registra se o estorno aconteceu: se o contador já estiver zerado, a refeição muda de status sem estorno.

**Lote de 2.** A `processMeal` recebe até 2 mensagens por vez, e o `lambdaSQSAdapter` processa as duas com `Promise.all`, sem retorno parcial de lote. Se uma lançar erro, a invocação termina na hora e as **duas** voltam para a fila:
- se a outra já tinha terminado, ela é ignorada no reprocessamento (status terminal);
- se ainda estava rodando, pode ser congelada no meio. Fica em `PROCESSING` até o lease vencer, **gasta uma tentativa** sem ter falhado e pode chamar a OpenAI de novo.

**Limitações conhecidas:**
- **Lease sem fencing completo.** Só o `markForRetry` confere o `leaseExpiresAt`. `markSuccess` e `rejectAndRefund` só exigem `status = PROCESSING`. Hoje o risco é teórico, porque o timeout (120 s) é menor que o lease (130 s). Volta a importar se esses números mudarem.
- **TTL dos contadores de cota.** O mensal expira 7 dias depois da virada e o diário em 15 dias. Um estorno depois disso muda o status sem estornar (`quotaRefunded: false`). Na prática não acontece, porque o estorno vem em minutos.
- **Arquivos órfãos.** Apagar o arquivo do S3 é melhor esforço (a falha só vai para o log), e o bucket não tem lifecycle rule.

## Refeição presa (checagem de 15 min)

A mensagem publicada na criação fica invisível por 15 minutos e então cai no `checkMealUpload`:

```mermaid
flowchart TD
    msg(["Mensagem da MealUploadCheckQueue<br/>15 min depois da criação"]) --> read["findById com ConsistentRead"]
    read --> exists{"Existe?"}
    exists -- "não<br/>a criação falhou depois de publicar" --> noop(["nada a fazer"])
    exists -- "sim" --> stalled{"UPLOADING<br/>ou QUEUED com attempts = 0?"}
    stalled -- "não<br/>já foi processada ou está em processamento" --> noop
    stalled -- "sim" --> fail["failAndRefund<br/>condicionado ao status lido"]
    fail --> del["apaga o arquivo do S3, se existir"]
```

Quando ela atua:

- **`UPLOADING`**: o app nunca mandou o arquivo (fechou, perdeu a rede ou o Presigned POST expirou) ou o evento do S3 falhou.
- **`QUEUED` com `attempts = 0`**: o arquivo chegou, mas a publicação na `MealsQueue` falhou, ou a fila está atrasada há mais de 10 minutos (o alarme `MealsQueueAgeAlarm` avisa bem antes, quando a mensagem mais antiga passa de 2 minutos).

A escrita é condicional ao status lido, então um upload que termina no último segundo **não** é estornado por engano.

## Erros e casos de borda

| Situação | Resultado | Cota |
|---|---|---|
| Free sem refeições no mês | `403 FREE_QUOTA_EXCEEDED` | Não consome |
| Pro com 20 refeições no dia | `429 DAILY_MEAL_LIMIT_REACHED` | Não consome |
| Mais de 10 criações na hora | `429 RATE_LIMIT_EXCEEDED` + `Retry-After` | Não consome |
| Corpo inválido (tipo, tamanho, `description` em áudio) | `400 VALIDATION` | Não consome |
| Falha ao gerar o upload, publicar ou gravar | `500` | Estornada na hora |
| Arquivo de tamanho diferente do declarado | O S3 recusa o upload, a refeição fica `UPLOADING` | Estornada em 15 min |
| Arquivo corrompido ou de outro formato | `REJECTED` / `INVALID_FILE` | Estornada |
| Foto sem comida | `REJECTED` / `NOT_A_MEAL` (com `gateScore`) | Estornada |
| Áudio sem fala ou sem alimento | `REJECTED` / `NO_FOOD_DETECTED` | Estornada |
| OpenAI fora do ar duas vezes | `FAILED` | Estornada |
| Cloudflare fora do ar | Segue sem o gate (falha aberta) | — |
| Mensagem duplicada do SQS | Ignorada (status terminal ou lease ativo) | — |

Em toda rejeição ou falha, o arquivo é apagado do S3.

## Arquivos envolvidos

| Etapa | Arquivo |
|---|---|
| Rota e config das Lambdas | [`sls/functions/meal.yml`](../../../sls/functions/meal.yml) |
| Filas, DLQs e alarmes | [`sls/resources/mealsQueue.yml`](../../../sls/resources/mealsQueue.yml), [`sls/resources/mealUploadCheckQueue.yml`](../../../sls/resources/mealUploadCheckQueue.yml) |
| Validação do corpo | [`createMealSchema.ts`](../../../src/application/controllers/meal/schemas/createMealSchema.ts) |
| Controller | [`CreateMealController.ts`](../../../src/application/controllers/meal/CreateMealController.ts) |
| Criação | [`CreateMealUseCase.ts`](../../../src/application/useCases/meal/CreateMealUseCase.ts) |
| Cotas | [`MealQuotaService.ts`](../../../src/application/services/MealQuotaService.ts) |
| Presigned POST, CDN e S3 | [`MealFileStorageGateway.ts`](../../../src/infra/gateways/MealFileStorageGateway.ts) |
| Evento do S3 | [`MealUploadedEventHandler.ts`](../../../src/application/events/MealUploadedEventHandler.ts) → [`MealUploadedUseCase.ts`](../../../src/application/useCases/meal/MealUploadedUseCase.ts) |
| Consumidor da fila | [`MealQueueConsumer.ts`](../../../src/application/queues/MealQueueConsumer.ts) → [`ProcessMealUseCase.ts`](../../../src/application/useCases/meal/ProcessMealUseCase.ts) |
| Validação do arquivo | [`MealFileValidationService.ts`](../../../src/application/services/MealFileValidationService.ts) |
| Gate | [`MealGateGateway.ts`](../../../src/infra/ai/gateways/MealGateGateway.ts) |
| IA e prompts | [`MealAiGateway.ts`](../../../src/infra/ai/gateways/MealAiGateway.ts), [`prompts/`](../../../src/infra/ai/prompts/) |
| Nome e ícone | [`MealNamingService.ts`](../../../src/application/services/MealNamingService.ts) |
| Estados, lease e estorno | [`Meal.ts`](../../../src/application/entities/Meal.ts), [`MealRepository.ts`](../../../src/infra/databases/dynamodb/MealRepository.ts) |
| Refeição presa | [`MealUploadCheckQueueConsumer.ts`](../../../src/application/queues/MealUploadCheckQueueConsumer.ts) → [`CheckMealUploadUseCase.ts`](../../../src/application/useCases/meal/CheckMealUploadUseCase.ts) |
| Polling no app | `app/src/app/hooks/queries/useGetMealById.ts` (repo do app) |

