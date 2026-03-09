---
name: test-feature
description: Test a React Native feature on simulator/emulator
arguments:
  - name: description
    description: What feature to test
    required: true
agent: rn-tester
---

Test the following feature on the simulator/emulator: {description}

Follow the 7-step testing protocol:
1. Check environment (cdp_status)
2. Read and understand the feature code
3. Plan test steps
4. Navigate to starting screen
5. Execute each step with UI + data verification
6. Test edge cases
7. Generate persistent Maestro test and report results
