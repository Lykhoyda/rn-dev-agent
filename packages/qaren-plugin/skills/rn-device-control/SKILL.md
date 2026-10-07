---
name: rn-device-control
description: Use for QaReN device selection, app preparation, screenshots, retained device leases, or ownership-safe cleanup.
---

# QaReN device ownership

Follow [Check a plan](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#check-a-plan) for device selection and app
preparation, and [iOS admission and cleanup](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#ios-admission-and-cleanup)
for retained leases and recovery. The CLI owns the run's device and producers;
use its recorded run identity and cleanup contract rather than ambient device
aliases or manual lock deletion.

Before interpreting a refused interaction, read [Occluded taps and focus](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#occluded-taps-and-focus)
and [Fill verification and keyboard fallback](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#fill-verification-and-keyboard-fallback).
For screenshots and recorded evidence, read [Input value masking](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#input-value-masking)
and [Test a pull request](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#test-a-pull-request).
For explicit Android or USB setup experiments, use [Preparation verbs](https://github.com/Lykhoyda/rn-dev-agent/blob/develop/packages/qaren-cli/README.md#preparation-verbs).
