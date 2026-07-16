// Survey conditional-visibility helpers.
//
// A question may carry `showIf: { questionId, equals }` meaning it only renders
// when the referenced question's answer equals the given value. This module
// centralizes the visibility computation so the builder, the response page,
// and the results view all agree on the semantics.
//
// Design constraints (see design doc "Show Only If"):
// - Only Yes/No and Multiple Choice questions may be a source.
// - Source must appear BEFORE the child in the survey order (prevents cycles).
// - Broken references (source deleted, or `equals` no longer matches an
//   option) fail OPEN: the child renders for everyone. Builder surfaces
//   an amber warning so the coach can clear or re-bind.

import { SurveyQuestion, SurveyQuestionType } from '../types';

export type ShowIfErrorCode =
  | 'source_missing'
  | 'source_not_conditionable'
  | 'source_after_child'
  | 'equals_not_in_options'
  | 'equals_missing';

export interface ShowIfError {
  code: ShowIfErrorCode;
  message: string;
}

const CONDITIONABLE_TYPES: SurveyQuestionType[] = ['yes_no', 'multiple_choice'];

/** Answers a source question can have. Empty array if source is not conditionable. */
export const possibleAnswersFor = (q: SurveyQuestion | undefined): string[] => {
  if (!q) return [];
  if (q.type === 'yes_no') return ['yes', 'no'];
  if (q.type === 'multiple_choice') return q.options || [];
  return [];
};

/** True iff this question type is allowed as a `showIf` source. */
export const isConditionableSource = (q: SurveyQuestion): boolean =>
  CONDITIONABLE_TYPES.includes(q.type);

/**
 * Returns the source questions eligible to be a `showIf` source for the
 * question at `childIndex`: Y/N + MC questions strictly before it in order.
 */
export const eligibleSourcesFor = (
  questions: SurveyQuestion[],
  childIndex: number,
): SurveyQuestion[] =>
  questions.slice(0, childIndex).filter(isConditionableSource);

/**
 * Validate a single question's `showIf` in the context of the full survey.
 * Returns null when the rule is valid (or absent).
 */
export const validateShowIf = (
  question: SurveyQuestion,
  allQuestions: SurveyQuestion[],
): ShowIfError | null => {
  const rule = question.showIf;
  if (!rule) return null;

  const source = allQuestions.find(q => q.id === rule.questionId);
  if (!source) {
    return { code: 'source_missing', message: 'The question this depends on was removed. It will show for everyone now.' };
  }
  if (!isConditionableSource(source)) {
    return { code: 'source_not_conditionable', message: 'This rule points to a question that can no longer be used as a source.' };
  }
  if (source.order >= question.order) {
    return { code: 'source_after_child', message: 'This question depends on one below it. Move it back down or remove the rule.' };
  }
  if (!rule.equals) {
    return { code: 'equals_missing', message: 'Pick an answer for this rule.' };
  }
  const answers = possibleAnswersFor(source);
  if (!answers.includes(rule.equals)) {
    return { code: 'equals_not_in_options', message: 'The answer this rule was tied to was renamed or removed.' };
  }
  return null;
};

/**
 * Runtime visibility check. Fails OPEN on broken rules to match the builder's
 * "degrade to always-visible" contract. Used by PublicSurvey + results caption.
 */
export const isVisible = (
  question: SurveyQuestion,
  allQuestions: SurveyQuestion[],
  answers: Record<string, string | number>,
): boolean => {
  const rule = question.showIf;
  if (!rule) return true;

  const source = allQuestions.find(q => q.id === rule.questionId);
  if (!source || !isConditionableSource(source)) return true; // fail open

  const possible = possibleAnswersFor(source);
  if (!possible.includes(rule.equals)) return true; // fail open (equals renamed/removed)

  // Also check the parent is itself visible; a hidden ancestor cascades.
  if (!isVisible(source, allQuestions, answers)) return false;

  return answers[rule.questionId] === rule.equals;
};

/**
 * Return the set of question ids currently visible given the answers snapshot.
 * Order-preserving: iterates in the given questions[] order.
 */
export const visibleQuestionIds = (
  questions: SurveyQuestion[],
  answers: Record<string, string | number>,
): Set<string> => {
  const set = new Set<string>();
  questions.forEach(q => {
    if (isVisible(q, questions, answers)) set.add(q.id);
  });
  return set;
};

/**
 * After a parent answer changes, drop any answers that belong to now-hidden
 * children. Cascades naturally because visibleQuestionIds cascades.
 */
export const pruneHiddenAnswers = (
  questions: SurveyQuestion[],
  answers: Record<string, string | number>,
): Record<string, string | number> => {
  const visible = visibleQuestionIds(questions, answers);
  let changed = false;
  const next: Record<string, string | number> = {};
  Object.keys(answers).forEach(qid => {
    if (visible.has(qid)) {
      next[qid] = answers[qid];
    } else {
      changed = true;
    }
  });
  return changed ? next : answers;
};
