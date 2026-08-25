from app.schemas.engineering import EngineeringAssessmentRequest, EngineeringAssessmentResponse, EngineeringFinding


def assess_engineering_metrics(request: EngineeringAssessmentRequest) -> EngineeringAssessmentResponse:
    findings: list[EngineeringFinding] = []
    if request.sample_count < 3:
        findings.append(EngineeringFinding(category="data_quality", classification="insufficient_data", severity="warning", message="At least three valid observations are required for engineering interpretation.", limitations=["Do not infer clipping, availability, or performance root cause from this sample."]))
        return EngineeringAssessmentResponse(findings=findings)
    if request.dc_ac_ratio is not None:
        findings.append(EngineeringFinding(category="dc_ac_ratio", classification="calculated", severity="info", message=f"The supplied DC/AC ratio is {request.dc_ac_ratio:.3f}.", limitations=["Optimal DC/AC ratio depends on irradiance distribution, tariff, module orientation, inverter specification, and project economics.", "This value is not an optimization recommendation without a project-specific model."]))
    if request.clipping_duration_minutes is not None:
        if request.product_specification_version is None:
            findings.append(EngineeringFinding(category="clipping", classification="insufficient_data", severity="warning", message="Clipping duration was supplied without an inverter specification version.", limitations=["Clipping thresholds must be evaluated against the effective inverter specification."]))
        else:
            severity = "warning" if request.clipping_duration_minutes > 0 else "info"
            findings.append(EngineeringFinding(category="clipping", classification="measured", severity=severity, message=f"Measured clipping duration is {request.clipping_duration_minutes:.1f} minutes for specification version {request.product_specification_version}.", limitations=["Confirm time alignment, operating-state validity, and the approved clipping threshold before attributing production loss."]))
    if request.availability_pct is not None:
        severity = "critical" if request.availability_pct < 90 else "warning" if request.availability_pct < 98 else "info"
        findings.append(EngineeringFinding(category="availability", classification="measured", severity=severity, message=f"Measured availability is {request.availability_pct:.2f}%.", limitations=["Planned maintenance and missing telemetry must be excluded according to the approved availability definition."]))
    if request.performance_ratio is not None:
        if not request.weather_aligned:
            findings.append(EngineeringFinding(category="performance", classification="insufficient_data", severity="warning", message="Performance ratio was supplied without weather alignment.", limitations=["Do not attribute low production to equipment until irradiance and weather alignment are verified."]))
        else:
            findings.append(EngineeringFinding(category="performance", classification="calculated", severity="info", message=f"Weather-aligned performance ratio is {request.performance_ratio:.3f}.", limitations=["This metric supports investigation but does not independently establish root cause."]))
    return EngineeringAssessmentResponse(findings=findings)
