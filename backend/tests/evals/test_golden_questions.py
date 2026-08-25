import json
from pathlib import Path


def test_golden_question_suite_has_expected_safety_outcomes() -> None:
    path = Path(__file__).with_name("golden_questions.json")
    cases = json.loads(path.read_text(encoding="utf-8"))

    assert len(cases) >= 5
    assert any(case["expected_status"] == "clarification_required" for case in cases)
    assert any(case["expected_status"] == "failed" for case in cases)
    assert all("question" in case and "expected_status" in case for case in cases)
