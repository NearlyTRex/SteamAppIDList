"""The meta suite: the test layout and quality rules, and eslint over the script and its tests."""

from pytest_testrex import suite


class TestRex(suite.TestRex):
    """The suite's own rules, from pytest-testrex."""
