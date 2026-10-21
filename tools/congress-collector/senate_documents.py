"""Shared raw Senate document projections and fail-closed bundle checks."""

DOCUMENT_FIELDS=('document_congress','document_type','document_number','document_name')
AMENDMENT_FIELDS=('amendment_number','amendment_to_document_number')


class SenateDocumentAmbiguity(ValueError):
    pass


def projection(node,names):
    values={}
    for name in names:
        nodes=node.findall(name)
        if len(nodes)!=1 or list(nodes[0]):
            raise ValueError(f'missing/duplicate/structured {name}')
        values[name]=nodes[0].text or ''
    return values


def read_senate_documents(root):
    """Keep every projection; use the first only after checking the bundle."""
    documents=[projection(node,DOCUMENT_FIELDS) for node in root.findall('document')]
    amendments=[projection(node,AMENDMENT_FIELDS) for node in root.findall('amendment')]
    amendment=amendments[0] if amendments else dict.fromkeys(AMENDMENT_FIELDS,'')
    if any(value!=amendment for value in amendments):
        raise SenateDocumentAmbiguity('conflicting Senate amendment projections')

    distinct={tuple(doc[name] for name in DOCUMENT_FIELDS) for doc in documents}
    if len(distinct)>1:
        # Multiple bills cannot be represented by one collector bill identity.
        # The supported distinct-document shape is the frozen PN en-bloc vote.
        if any(doc['document_type'].strip()!='PN' for doc in documents):
            raise SenateDocumentAmbiguity('multiple Senate documents are not a PN bundle')
        if any(doc['document_congress'].strip()!=(root.findtext('congress') or '').strip() for doc in documents):
            raise SenateDocumentAmbiguity('conflicting Senate document congresses')
        numbers=[doc['document_number'].strip() for doc in documents]
        if any(not number for number in numbers) or len(set(numbers))!=len(numbers):
            raise SenateDocumentAmbiguity('empty or duplicate Senate nomination numbers')
        if any(value.strip() for value in amendment.values()):
            raise SenateDocumentAmbiguity('Senate nomination bundle contains amendment identity')

    documents=[{**doc,**amendment} for doc in documents]
    first=documents[0] if documents else {**dict.fromkeys(DOCUMENT_FIELDS,''),**amendment}
    return first,documents
