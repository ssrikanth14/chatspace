-- Preserve the existing shared-room history in a related legacy conversation.
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "directKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_directKey_key" ON "Conversation"("directKey");
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key"
    ON "ConversationParticipant"("conversationId", "userId");
CREATE INDEX "ConversationParticipant_conversationId_idx"
    ON "ConversationParticipant"("conversationId");
CREATE INDEX "ConversationParticipant_userId_idx"
    ON "ConversationParticipant"("userId");

INSERT INTO "Conversation" ("id", "directKey", "createdAt", "updatedAt")
VALUES ('legacy-shared-room', 'legacy-shared-room', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "ConversationParticipant" ("id", "conversationId", "userId")
SELECT 'legacy-' || "id", 'legacy-shared-room', "id"
FROM "User";

ALTER TABLE "Message" ADD COLUMN "conversationId" TEXT;

UPDATE "Message"
SET "conversationId" = 'legacy-shared-room'
WHERE "conversationId" IS NULL;

ALTER TABLE "Message" ALTER COLUMN "conversationId" SET NOT NULL;

CREATE INDEX "Message_conversationId_createdAt_id_idx"
    ON "Message"("conversationId", "createdAt", "id");

ALTER TABLE "ConversationParticipant"
    ADD CONSTRAINT "ConversationParticipant_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationParticipant"
    ADD CONSTRAINT "ConversationParticipant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message"
    ADD CONSTRAINT "Message_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
