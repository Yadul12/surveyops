"""
Unit tests for SurveyOps pipeline conditional logic, normalization, validation rules, and fingerprinting.
"""
import uuid
from types import SimpleNamespace

from app.pipeline.engine import (
    compute_fingerprint,
    evaluate_conditional_logic,
    evaluate_validation_rule,
    normalize_answer_value,
)


def test_conditional_logic_operators():
    answers = {
        "mode": "municipal_bus",
        "wait": 22,
        "barriers": ["broken_elevator", "uneven_curb"],
        "notes": "Peak delay near north terminal",
    }

    assert evaluate_conditional_logic(None, answers) is True
    assert evaluate_conditional_logic(
        {"operator": "all", "rules": [{"question_key": "mode", "condition": "equals", "value": "municipal_bus"}]},
        answers,
    ) is True
    assert evaluate_conditional_logic(
        {"operator": "all", "rules": [{"question_key": "mode", "condition": "not_equals", "value": "private_vehicle"}]},
        answers,
    ) is True
    assert evaluate_conditional_logic(
        {"operator": "all", "rules": [{"question_key": "mode", "condition": "in", "value": ["municipal_bus", "light_rail"]}]},
        answers,
    ) is True
    assert evaluate_conditional_logic(
        {"operator": "all", "rules": [{"question_key": "barriers", "condition": "contains", "value": "broken_elevator"}]},
        answers,
    ) is True
    assert evaluate_conditional_logic(
        {"operator": "all", "rules": [{"question_key": "wait", "condition": "greater_than", "value": 15}]},
        answers,
    ) is True
    assert evaluate_conditional_logic(
        {"operator": "all", "rules": [{"question_key": "wait", "condition": "less_than", "value": 10}]},
        answers,
    ) is False
    assert evaluate_conditional_logic(
        {
            "operator": "any",
            "rules": [
                {"question_key": "wait", "condition": "less_than", "value": 10},
                {"question_key": "notes", "condition": "is_answered", "value": True},
            ],
        },
        answers,
    ) is True


def test_normalization_across_question_types():
    # Text whitespace normalization
    norm, num, txt, err = normalize_answer_value("short_text", "   North   Station   Bus  ", [])
    assert norm == "North Station Bus"
    assert err is None

    # Numeric comma parsing
    norm, num, txt, err = normalize_answer_value("number", "1,250.5", [])
    assert norm == 1250.5
    assert num == 1250.5
    assert err is None

    # Invalid numeric rejected
    _, _, _, err = normalize_answer_value("number", "not-a-number", [])
    assert err is not None

    # Boolean string coercion
    norm, num, txt, err = normalize_answer_value("boolean", "YES", [])
    assert norm is True and num == 1.0 and txt == "true" and err is None

    # Date normalization
    norm, _, _, err = normalize_answer_value("date", "2026/11/15", [])
    assert norm == "2026-11-15" and err is None

    # Single choice label -> canonical code mapping
    opts = [{"value": "municipal_bus", "label": "Municipal Bus"}]
    norm, _, txt, err = normalize_answer_value("single_choice", "Municipal Bus", opts)
    assert norm == "municipal_bus" and txt == "municipal_bus" and err is None

    # Invalid single choice flagged
    _, _, _, err = normalize_answer_value("single_choice", "helicopter", opts)
    assert err is not None

    # Multi choice deduplication
    mopts = [{"value": "a", "label": "Alpha"}, {"value": "b", "label": "Beta"}]
    norm, num, _, err = normalize_answer_value("multi_choice", ["Alpha", "a", "Beta"], mopts)
    assert norm == ["a", "b"] and num == 2.0 and err is None

    # Location bounds validation
    norm, _, _, err = normalize_answer_value("location", {"lat": 40.75801234, "lng": -73.98551234}, [])
    assert norm == {"lat": 40.758012, "lng": -73.985512} and err is None
    _, _, _, err = normalize_answer_value("location", {"lat": 120.0, "lng": -73.9}, [])
    assert err is not None


def test_validation_rules_and_fingerprint_determinism():
    outlier_rule = SimpleNamespace(
        is_active=True,
        rule_type="outlier_bounds",
        rule_config={"min": 1, "max": 60},
        error_message="Wait time outlier",
    )
    assert evaluate_validation_rule(outlier_rule, 25, 25.0) is None
    res = evaluate_validation_rule(outlier_rule, 140, 140.0)
    assert res is not None and res[0] == "outlier"

    regex_rule = SimpleNamespace(
        is_active=True,
        rule_type="regex",
        rule_config={"pattern": r"^HH-[A-Z]{3}-\d{4}$"},
        error_message="Invalid ref format",
    )
    assert evaluate_validation_rule(regex_rule, "HH-NOR-1042", None) is None
    assert evaluate_validation_rule(regex_rule, "bad-ref", None)[0] == "validation_failure"

    vid = uuid.uuid4()
    fp1 = compute_fingerprint(vid, "North Metro", {"b": 2, "a": 1})
    fp2 = compute_fingerprint(vid, " north metro ", {"a": 1, "b": 2})
    assert fp1 == fp2
