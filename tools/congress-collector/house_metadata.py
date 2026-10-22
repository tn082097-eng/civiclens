"""Shared fail-closed check for official House metadata label variants."""

HOUSE_LABEL = 'U.S. House of Representatives'


def validate_house_label(metadata):
    """Require chamber and/or committee, with every present label plain/exact.

    Each name may occur once. Children, attributes, empty text and non-exact
    text are unsupported; a valid other label never hides an invalid one.
    """
    present = False
    for name in ('chamber', 'committee'):
        nodes = metadata.findall(name)
        if not nodes:
            continue
        present = True
        if len(nodes) != 1 or list(nodes[0]) or nodes[0].attrib:
            raise ValueError(f'duplicate/structured House {name}')
        if nodes[0].text != HOUSE_LABEL:
            raise ValueError(f'wrong or empty House {name}')
    if not present:
        raise ValueError('missing House chamber and committee')
