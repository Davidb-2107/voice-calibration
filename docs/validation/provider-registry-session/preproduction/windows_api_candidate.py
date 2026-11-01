"""The API uses the existing zero-capability AppContainer, with an exact Node pin."""
from node_runtime import pinned_node
from windows_candidate import WindowsCandidate


class WindowsApiCandidate(WindowsCandidate):
    def _validate_command(self, argv):
        super()._validate_command(argv)
        pinned_node(argv[0])
