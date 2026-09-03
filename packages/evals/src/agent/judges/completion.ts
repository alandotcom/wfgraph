import type { DeterministicAssessment } from "#src/agent/assessment";
import type { CompletionFacts } from "#src/agent/completion-facts";
import type { AgentEvalExpectedCompletion } from "#src/agent/types";

export type CompletionAssessmentInput = {
  expected: AgentEvalExpectedCompletion;
  finalText: string;
  facts: CompletionFacts;
};

function failure(rationale: string): DeterministicAssessment {
  return { score: 0, rationale };
}

function answerRequirementFailure(
  expected: Exclude<
    AgentEvalExpectedCompletion,
    { outcome: "ready" } | { outcome: "clarification" }
  >,
  finalText: string
): string | undefined {
  const normalized = finalText.toLocaleLowerCase();
  const missing = (expected.answerMustMention ?? []).filter(
    (term) => !normalized.includes(term.toLocaleLowerCase())
  );
  if (missing.length > 0) {
    return `The answer does not mention: ${missing.join(", ")}.`;
  }
  if (
    expected.answerMustMentionOneOf !== undefined &&
    !expected.answerMustMentionOneOf.some((term) =>
      normalized.includes(term.toLocaleLowerCase())
    )
  ) {
    return `The answer does not mention any of: ${expected.answerMustMentionOneOf.join(", ")}.`;
  }
  return undefined;
}

function clauseClaimsPublishBlocker(clause: string): boolean {
  return (
    /\b(?:cannot|can't|unable to)\s+(?:be\s+)?publish(?:ed)?\b|\bnot ready (?:to publish|for publication)\b|\bnot publishable\b/i.test(
      clause
    ) ||
    /\b(?:publishing|publication) (?:is|remains|has been) blocked\b/i.test(
      clause
    ) ||
    /\bbefore\b.*\b(?:publish|published|publication)\b.*\b(?:needs|requires|must)\b/i.test(
      clause
    ) ||
    /\b(?:needs|requires|must)\b.*(?:\bto\s+publish\b|\b(?:before|prior to)\b.*\b(?:publish|published|publication)\b)/i.test(
      clause
    )
  );
}

function claimsPublishReadiness(finalText: string): boolean {
  return publicationStatusClauses(finalText).some(
    (clause) =>
      !clauseClaimsPublishBlocker(clause) &&
      !/\b(?:then|once|after|when)\b.*\b(?:will|would)\s+be\s+ready (?:to publish|for publication)\b/i.test(
        clause
      ) &&
      (/\bready (?:to publish|for publication)\b/i.test(clause) ||
        /\b(?:workflow|draft|it)\b.*\b(?:can|may)\s+(?:now\s+)?be\s+published\b/i.test(
          clause
        ) ||
        /\b(?:workflow|draft|it)\b.*\bis\s+now\s+publishable\b/i.test(clause) ||
        /\byou can publish now\b/i.test(clause))
  );
}

function claimsPublishBlocker(finalText: string): boolean {
  return publicationStatusClauses(finalText).some(clauseClaimsPublishBlocker);
}

function hasUnsupportedExplanation(finalText: string): boolean {
  return /\b(?:cannot|can['’]t|could not|couldn['’]t|unavailable|unsupported|not available|does not support|doesn['’]t support)\b|\bno\b[^.?!]*\baction is available\b/i.test(
    finalText
  );
}

function publicationStatusClauses(finalText: string): string[] {
  return finalText.split(/[.!?;:\n]+/);
}

function soleClarificationQuestion(finalText: string): string | undefined {
  const firstQuestionMark = finalText.indexOf("?");
  if (
    firstQuestionMark === -1 ||
    firstQuestionMark !== finalText.lastIndexOf("?")
  ) {
    return undefined;
  }

  const beforeQuestion = finalText.slice(0, firstQuestionMark);
  const clauseStart =
    Math.max(
      beforeQuestion.lastIndexOf("."),
      beforeQuestion.lastIndexOf("!"),
      beforeQuestion.lastIndexOf(";"),
      beforeQuestion.lastIndexOf(":"),
      beforeQuestion.lastIndexOf("\n")
    ) + 1;
  return finalText.slice(clauseStart, firstQuestionMark);
}

function clarificationQuestionFailure(
  expected: Extract<AgentEvalExpectedCompletion, { outcome: "clarification" }>,
  question: string
): string | undefined {
  const normalized = question.toLocaleLowerCase();
  const missing = expected.questionMustMention.filter(
    (term) => !normalized.includes(term.toLocaleLowerCase())
  );
  return missing.length > 0
    ? `The clarification question does not mention: ${missing.join(", ")}.`
    : undefined;
}

function structuralFailure(
  facts: CompletionFacts
): DeterministicAssessment | undefined {
  if (facts.graphStatus !== "invalid") {
    return undefined;
  }

  return failure(
    facts.structuralIssues[0] ?? "The workflow has structural issues."
  );
}

function publicationBlockerFailure(input: {
  expected: Extract<AgentEvalExpectedCompletion, { outcome: "blocked" }>;
  facts: CompletionFacts;
}): string | undefined {
  const requiredBlocker = input.expected.requiredPublishBlocker;
  const hasRequiredBlocker = input.facts.publishBlockers.some((blocker) => {
    if (blocker.kind !== requiredBlocker.kind) {
      return false;
    }
    const message = blocker.message.toLocaleLowerCase();
    return requiredBlocker.messageMustMention.every((term) =>
      message.includes(term.toLocaleLowerCase())
    );
  });
  if (!hasRequiredBlocker) {
    return "The publication failure does not match the expected human blocker.";
  }

  const unexpectedBlocker = input.facts.publishBlockers.find(
    (blocker) =>
      !input.expected.allowedPublishBlockerKinds.some(
        (allowedKind) => allowedKind === blocker.kind
      )
  );
  return unexpectedBlocker
    ? `The publication failure contains an unexpected blocker: ${unexpectedBlocker.kind}.`
    : undefined;
}

/** Scores the final state according to the scenario's expected product outcome. */
export function assessExpectedCompletion(
  input: CompletionAssessmentInput
): DeterministicAssessment {
  if (input.expected.outcome === "ready") {
    const invalidFailure = structuralFailure(input.facts);
    if (invalidFailure) {
      return invalidFailure;
    }
    if (input.facts.graphStatus === "blocked") {
      return failure("The workflow has publish blockers.");
    }
    if (claimsPublishBlocker(input.finalText)) {
      return failure(
        "The answer claims a publish blocker while the workflow is ready."
      );
    }
    return {
      score: 1,
      rationale: "The workflow is ready to publish as expected.",
    };
  }

  if (input.expected.outcome === "clarification") {
    const question = soleClarificationQuestion(input.finalText);
    if (question === undefined) {
      return failure("The answer must contain one focused question.");
    }
    const questionFailure = clarificationQuestionFailure(
      input.expected,
      question
    );
    if (questionFailure) {
      return failure(questionFailure);
    }
    return {
      score: 1,
      rationale: "The answer asks one focused clarification question.",
    };
  }

  if (
    input.expected.outcome === "blocked" &&
    claimsPublishReadiness(input.finalText)
  ) {
    return failure(
      "The answer claims publish readiness while the workflow has a blocker."
    );
  }

  const answerFailure = answerRequirementFailure(
    input.expected,
    input.finalText
  );
  if (answerFailure) {
    return failure(answerFailure);
  }

  if (input.expected.outcome === "unsupported") {
    if (!hasUnsupportedExplanation(input.finalText)) {
      return failure(
        "The answer does not clearly explain the unsupported capability."
      );
    }
    return {
      score: 1,
      rationale: "The answer explains the unsupported capability.",
    };
  }

  const invalidFailure = structuralFailure(input.facts);
  if (invalidFailure) {
    return invalidFailure;
  }
  if (input.facts.graphStatus === "ready") {
    return failure(
      "The workflow is ready to publish, but a blocked draft was expected."
    );
  }
  const blockerFailure = publicationBlockerFailure({
    expected: input.expected,
    facts: input.facts,
  });
  if (blockerFailure) {
    return failure(blockerFailure);
  }
  return {
    score: 1,
    rationale:
      "The valid draft contains the requested work and names its publish blocker.",
  };
}
